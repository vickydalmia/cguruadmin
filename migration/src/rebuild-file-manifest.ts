import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
import { buildLocalHashMap } from "./phases/14-media-optimize.js";
import { slugifyFileName } from "./utils/image-optimizer.js";
import {
  reconstructFormatsFromListing,
  type FileManifestEntry,
} from "./utils/manifest-core.js";
import {
  listS3ObjectsWithSizes,
  loadFileManifest,
  s3RootPrefix,
  s3UrlPrefix,
  saveFileManifest,
  syncManifestFromDb,
  upsertManifestEntry,
  uploadManifestMirror,
} from "./utils/file-manifest.js";

// The application owns the algorithm (same dynamic import as phase 02).
const { calculateImageBackgroundColour } = await import(
  "../../src/utils/image-background-colour.js"
);

const ARCHIVE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../background-removed-deal-images",
);

const MIME_BY_EXT: Record<string, string> = {
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

interface RebuildCandidate {
  hash: string;
  localPath: string;
  /** files.name — the original file name, extension included. */
  fileName: string;
  backgroundRemoval: FileManifestEntry["backgroundRemoval"];
}

function hashFile(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex")
    .substring(0, 16);
}

/**
 * The FAL output archive: background-removed-deal-images/{version}/
 * {sourceSha256}-{name}.png. Each file is a transparent PNG that phase 08a
 * uploads through the normal pipeline, so its content hash is a first-class
 * manifest candidate carrying background_removal_* metadata.
 */
function archiveCandidates(): RebuildCandidate[] {
  const candidates: RebuildCandidate[] = [];
  if (!fs.existsSync(ARCHIVE_DIR)) return candidates;
  for (const version of fs.readdirSync(ARCHIVE_DIR)) {
    const versionDir = path.join(ARCHIVE_DIR, version);
    if (!fs.statSync(versionDir).isDirectory()) continue;
    for (const file of fs.readdirSync(versionDir)) {
      const match = /^([0-9a-f]{64})-(.+)$/.exec(file);
      if (!match) continue;
      const fullPath = path.join(versionDir, file);
      try {
        candidates.push({
          hash: hashFile(fullPath),
          localPath: fullPath,
          fileName: match[2],
          backgroundRemoval: {
            sourceHash: match[1],
            version,
            removedAt: fs.statSync(fullPath).mtime.toISOString(),
          },
        });
      } catch {
        // unreadable archive file — skip
      }
    }
  }
  return candidates;
}

async function orientedSourceDims(
  filePath: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(filePath).metadata();
    const swapped = (meta.orientation ?? 1) >= 5;
    const width = (swapped ? meta.height : meta.width) ?? 0;
    const height = (swapped ? meta.width : meta.height) ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

async function rebuildFromS3(skipColours: boolean): Promise<void> {
  const rootPrefix = s3RootPrefix();
  if (!config.s3.bucket || !config.s3.accessKeyId || !rootPrefix) {
    throw new Error(
      "S3 credentials and a non-empty S3_ROOT_PATH are required for rebuild",
    );
  }
  const urlPrefix = s3UrlPrefix();

  const hashToPath = buildLocalHashMap();
  const candidates: RebuildCandidate[] = [
    ...[...hashToPath.entries()].map(([hash, localPath]) => ({
      hash,
      localPath,
      fileName: path.basename(localPath),
      backgroundRemoval: null,
    })),
    ...archiveCandidates(),
  ];
  logger.info(
    `Rebuild candidates: ${candidates.length} ` +
      `(${hashToPath.size} from uploads tree, ` +
      `${candidates.length - hashToPath.size} from the transparent archive)`,
  );

  const listing = await listS3ObjectsWithSizes(rootPrefix);
  logger.info(`S3 listing: ${listing.size} object(s) under ${rootPrefix}`);

  // Group folder-scheme keys by their folder segment for O(1) per-candidate
  // lookups. Legacy flat keys (directly under the root) are not
  // reconstructable and are simply not indexed here.
  const byFolder = new Map<string, Map<string, number>>();
  for (const [key, size] of listing) {
    const relative = key.slice(rootPrefix.length);
    const slash = relative.indexOf("/");
    if (slash <= 0 || relative.indexOf("/", slash + 1) !== -1) continue;
    const folder = relative.slice(0, slash);
    let group = byFolder.get(folder);
    if (!group) {
      group = new Map();
      byFolder.set(folder, group);
    }
    group.set(key, size);
  }

  await loadFileManifest();
  const syncedAt = new Date().toISOString();
  let reconstructed = 0;
  let transparent = 0;
  let notUploaded = 0;
  let ambiguous = 0;
  const ambiguousSamples: string[] = [];

  for (const candidate of candidates) {
    const nameNoExt = path.basename(
      candidate.fileName,
      path.extname(candidate.fileName),
    );
    const slug = slugifyFileName(nameNoExt);
    const folder = `${slug}-${candidate.hash.slice(0, 8)}`;
    const folderKeys = byFolder.get(folder);
    if (!folderKeys || folderKeys.size === 0) {
      notUploaded += 1; // never uploaded — the normal path will process it
      continue;
    }

    // The master is the object named exactly `${slug}.<ext>`. Prefer the
    // non-AVIF candidate: for webp masters, `${slug}.avif` beside it is the
    // original_avif twin, not the master.
    const masterCandidates = [...folderKeys.keys()].filter((key) => {
      const base = path.basename(key);
      return path.basename(base, path.extname(base)) === slug;
    });
    const masterKey =
      masterCandidates.find((key) => !key.endsWith(".avif")) ??
      masterCandidates[0];
    if (!masterKey) {
      ambiguous += 1;
      if (ambiguousSamples.length < 10) {
        ambiguousSamples.push(`${folder}: no master object`);
      }
      continue;
    }

    const dims = await orientedSourceDims(candidate.localPath);
    if (!dims) {
      ambiguous += 1;
      if (ambiguousSamples.length < 10) {
        ambiguousSamples.push(`${folder}: source not decodable`);
      }
      continue;
    }

    const masterExt = path.extname(masterKey).toLowerCase();
    const masterMime = MIME_BY_EXT[masterExt] ?? "application/octet-stream";
    const result = reconstructFormatsFromListing({
      sourceWidth: dims.width,
      sourceHeight: dims.height,
      masterKey,
      masterExt,
      masterMime,
      masterSizeBytes: folderKeys.get(masterKey) ?? 0,
      slug,
      keyPrefix: `${rootPrefix}${folder}/`,
      urlPrefix,
      sizesByKey: folderKeys,
    });
    if (result.ambiguous.length > 0) {
      ambiguous += 1;
      if (ambiguousSamples.length < 10) {
        ambiguousSamples.push(`${folder}: ${result.ambiguous[0]}`);
      }
      continue;
    }

    let backgroundColour: string | null = null;
    if (!skipColours) {
      try {
        backgroundColour = await calculateImageBackgroundColour(
          fs.readFileSync(candidate.localPath),
        );
      } catch {
        backgroundColour = null;
      }
    }

    const entry: FileManifestEntry = {
      name: candidate.fileName,
      alternativeText: null,
      caption: null,
      width: result.width,
      height: result.height,
      formats: result.formatsJson,
      ext: masterExt,
      mime: masterMime,
      sizeKb: parseFloat(
        ((folderKeys.get(masterKey) ?? 0) / 1024).toFixed(2),
      ),
      url: `${urlPrefix}/${masterKey}`,
      providerMetadata: { key: masterKey },
      backgroundColour,
      backgroundRemoval: candidate.backgroundRemoval,
      masterKeys: [masterKey],
      s3Keys: result.s3Keys,
      syncedAt,
    };
    await upsertManifestEntry(candidate.hash, entry);
    reconstructed += 1;
    if (candidate.backgroundRemoval) transparent += 1;
    if (reconstructed % 1000 === 0) {
      logger.info(`  Reconstructed ${reconstructed} entrie(s)...`);
    }
  }

  for (const sample of ambiguousSamples) logger.info(`  ambiguous: ${sample}`);
  logger.info(
    `Manifest rebuild: reconstructed=${reconstructed} ` +
      `(transparent=${transparent}), ambiguous=${ambiguous}, ` +
      `not-yet-uploaded=${notUploaded}`,
  );
  await saveFileManifest();
  await uploadManifestMirror();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--from-db")) {
      // Exact mode: snapshot the files table PG_CONNECTION_STRING points at
      // (temporarily aim .env.migration at the OLD database to bootstrap a
      // manifest from it — verbatim formats, colours, tombstones).
      logger.info(
        "Rebuilding manifest from the files table at PG_CONNECTION_STRING...",
      );
      const { synced } = await syncManifestFromDb();
      logger.info(`Manifest rebuilt from database: ${synced} entrie(s)`);
      await saveFileManifest();
      await uploadManifestMirror();
    } else {
      await rebuildFromS3(args.includes("--skip-colours"));
    }
  } catch (err: any) {
    logger.error(`Manifest rebuild failed: ${err.message}`);
    logger.error(err.stack);
    process.exitCode = 1;
  } finally {
    await closePg();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
