import fs from "fs";
import path from "path";
import {
  S3Client,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { pgQuery } from "../db/pg-client.js";
import { logger } from "./logger.js";
import {
  emptyFileManifest,
  manifestEntryFromRow,
  type FileManifest,
  type FileManifestEntry,
  type FilesRowLike,
} from "./manifest-core.js";

// `*Map.json` survives clearCheckpoints() — the manifest must outlive --clean,
// exactly like the ID maps: it IS the reuse index once the DB is wiped.
const MANIFEST_PATH = path.resolve(
  config.stateDir,
  "fileManifestMap.json",
);

/** S3 prefix reserved for migration bookkeeping, excluded from orphan cleanup. */
export function manifestMirrorKey(): string {
  const rootPath = config.s3.rootPath?.replace(/^\/+|\/+$/g, "") ?? "";
  return `${rootPath ? `${rootPath}/` : ""}.migration/${config.profile}/files-manifest.json`;
}

/** Root prefix with trailing slash ("" when unscoped), as the key index uses. */
export function s3RootPrefix(): string {
  return config.s3.rootPath
    ? `${config.s3.rootPath.replace(/^\/+|\/+$/g, "")}/`
    : "";
}

/** The URL prefix files rows are built against (mirrors phase 02). */
export function s3UrlPrefix(): string {
  return config.s3.baseUrl
    ? config.s3.baseUrl.replace(/\/+$/, "")
    : `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`;
}

// Own lazy client: importing getS3Client from 02-media-upload would create a
// module cycle with that file's top-level awaits.
let s3Client: S3Client | null = null;
function getClient(): S3Client {
  if (!s3Client) {
    const s3Config: any = {
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    };
    if (config.s3.endpoint) {
      s3Config.endpoint = config.s3.endpoint;
      s3Config.forcePathStyle = true;
    }
    s3Client = new S3Client(s3Config);
  }
  return s3Client;
}

let manifestPromise: Promise<FileManifest> | null = null;
let dirty = false;

async function fetchMirror(): Promise<FileManifest | null> {
  if (!config.s3.bucket || !config.s3.accessKeyId) return null;
  try {
    const response = await getClient().send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: manifestMirrorKey(),
      }),
    );
    const body = await response.Body?.transformToString("utf8");
    if (!body) return null;
    logger.info("File manifest: loaded S3 mirror copy");
    return JSON.parse(body) as FileManifest;
  } catch {
    return null;
  }
}

function validate(manifest: FileManifest | null): FileManifest | null {
  if (!manifest || manifest.version !== 1 || typeof manifest.entries !== "object") {
    return null;
  }
  const urlPrefix = s3UrlPrefix();
  if (manifest.urlPrefix !== urlPrefix) {
    // Entries embed absolute URLs; reusing them under a different base URL
    // would insert rows pointing at the wrong host. Reprocessing is safe.
    logger.warn(
      `File manifest ignored: built for ${manifest.urlPrefix}, ` +
        `current base URL is ${urlPrefix}`,
    );
    return null;
  }
  return manifest;
}

export async function loadFileManifest(): Promise<FileManifest> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    if (fs.existsSync(MANIFEST_PATH)) {
      try {
        const local = validate(
          JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as FileManifest,
        );
        if (local) {
          logger.info(
            `File manifest: ${Object.keys(local.entries).length} entrie(s) loaded`,
          );
          return local;
        }
      } catch (err: any) {
        logger.warn(`File manifest unreadable, starting empty: ${err.message}`);
      }
    }
    const mirrored = validate(await fetchMirror());
    if (mirrored) {
      dirty = true; // persist the mirror locally on the next save
      return mirrored;
    }
    return emptyFileManifest(s3UrlPrefix());
  })();
  return manifestPromise;
}

export async function getManifestEntry(
  hash: string,
): Promise<FileManifestEntry | undefined> {
  const manifest = await loadFileManifest();
  return manifest.entries[hash];
}

export async function upsertManifestEntry(
  hash: string,
  entry: FileManifestEntry,
): Promise<void> {
  const manifest = await loadFileManifest();
  manifest.entries[hash] = entry;
  dirty = true;
}

export async function pruneManifestEntries(
  keep: (hash: string, entry: FileManifestEntry) => boolean,
): Promise<number> {
  const manifest = await loadFileManifest();
  let pruned = 0;
  for (const [hash, entry] of Object.entries(manifest.entries)) {
    if (!keep(hash, entry)) {
      delete manifest.entries[hash];
      pruned += 1;
    }
  }
  if (pruned > 0) dirty = true;
  return pruned;
}

/** Atomic local write; a crash can never leave a half-written manifest. */
export async function saveFileManifest(): Promise<void> {
  if (!manifestPromise || !dirty) return;
  const manifest = await manifestPromise;
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  const tmpPath = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest));
  fs.renameSync(tmpPath, MANIFEST_PATH);
  dirty = false;
}

export async function uploadManifestMirror(): Promise<void> {
  if (!config.s3.bucket || !config.s3.accessKeyId) return;
  const manifest = await loadFileManifest();
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: manifestMirrorKey(),
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
    }),
  );
  logger.info("File manifest: S3 mirror updated");
}

/** Forget everything — used by --clean --delete-media (objects are gone). */
export async function clearFileManifest(): Promise<void> {
  manifestPromise = Promise.resolve(emptyFileManifest(s3UrlPrefix()));
  dirty = true;
  if (fs.existsSync(MANIFEST_PATH)) fs.unlinkSync(MANIFEST_PATH);
  logger.info("File manifest cleared");
}

export const FILES_ROW_SELECT = `
  SELECT id, document_id, name, alternative_text, caption, width, height, formats, ext, mime,
         size, hash, url, provider, provider_metadata, background_colour,
         background_removal_source_hash, background_removal_version,
         background_removed_at
    FROM files
   WHERE provider = 'aws-s3' AND hash IS NOT NULL`;

/**
 * Snapshot every aws-s3 files row into the manifest (upsert — entries for
 * images not referenced this run stay valid until orphan cleanup prunes
 * them). One call at the end of a run captures every mutation phases
 * 08a/14/15 made, so those phases need no instrumentation of their own.
 */
export async function syncManifestFromDb(): Promise<{ synced: number }> {
  const manifest = await loadFileManifest();
  const urlPrefix = s3UrlPrefix();
  const rootPrefix = s3RootPrefix();
  const syncedAt = new Date().toISOString();
  const rows = await pgQuery<FilesRowLike>(FILES_ROW_SELECT);
  let synced = 0;
  for (const row of rows) {
    const entry = manifestEntryFromRow(row, urlPrefix, rootPrefix, syncedAt);
    if (!entry) continue;
    manifest.entries[row.hash] = entry;
    synced += 1;
  }
  if (synced > 0) dirty = true;
  return { synced };
}

/** Batched (≤1000/request) quiet deletion; returns the count issued. */
export async function deleteS3Objects(keys: readonly string[]): Promise<number> {
  const client = getClient();
  for (let start = 0; start < keys.length; start += 1000) {
    const batch = keys.slice(start, start + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.s3.bucket,
        Delete: {
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: true,
        },
      }),
    );
  }
  return keys.length;
}

/** Paginated Key → Size listing shared by rebuild and orphan cleanup. */
export async function listS3ObjectsWithSizes(
  prefix: string,
): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  let continuationToken: string | undefined;
  do {
    const response = await getClient().send(
      new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) objects.set(object.Key, object.Size ?? 0);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return objects;
}
