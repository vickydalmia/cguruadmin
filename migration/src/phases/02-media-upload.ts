import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getMediaInventory, getOrLoadMediaItem } from "./01-media-inventory.js";
import { pgQuery } from "../db/pg-client.js";
import { setMediaMapping } from "../utils/id-maps.js";
import { generateDocumentId } from "../utils/strapi-insert.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  optimizeOriginal,
  generateStrapiFormats,
  slugifyFileName,
} from "../utils/image-optimizer.js";
import { mediaSourceResolution } from "../utils/media-source-candidates.js";

// The application owns the algorithm; the migration imports it dynamically
// because cguruadmin is CommonJS while this package runs as ESM under tsx.
const { calculateImageBackgroundColour } = await import(
  "../../../src/utils/image-background-colour.js"
);

/** MIME types that go through optimizeOriginal (resize/webp/recompress). */
const OPTIMIZABLE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/tiff",
]);

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
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

export function hashBuffer(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
}

function getExtension(fileName: string): string {
  const ext = path.extname(fileName);
  return ext.startsWith(".") ? ext : `.${ext}`;
}

async function getImageDimensions(
  filePath: string,
  mimeType: string
): Promise<{ width: number | null; height: number | null }> {
  if (!mimeType.startsWith("image/")) return { width: null, height: null };
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(filePath).metadata();
    return { width: meta.width || null, height: meta.height || null };
  } catch {
    return { width: null, height: null };
  }
}

/** Everything content rewriting needs to point at an uploaded file. */
export interface UploadedFileRecord {
  id: number;
  name?: string;
  hash?: string;
  ext?: string;
  url: string;
  formats: Record<string, any> | null;
  width: number | null;
  height: number | null;
  /** Present for records loaded by the migration uploader; optional for
   * callers that only need responsive-image fields. */
  provider?: string;
  providerMetadata?: unknown;
}

function parseFormats(value: unknown): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value as Record<string, any>;
}

// Cache of hash → strapi file id (to avoid duplicate uploads)
const existingHashes = new Map<string, number>();
// Cache of file id → record (url/formats/dimensions), filled lazily by
// getFileRecordById and by fresh inserts — eagerly loading formats jsonb for
// the whole files table would waste memory on records never referenced.
const fileRecords = new Map<number, UploadedFileRecord>();
let hashCacheLoaded = false;

async function loadHashCache(): Promise<void> {
  if (hashCacheLoaded) return;
  const rows = await pgQuery<{ hash: string; id: number }>(
    `SELECT hash, id FROM files WHERE hash IS NOT NULL`
  );
  for (const row of rows) {
    existingHashes.set(row.hash, row.id);
  }
  hashCacheLoaded = true;
}

export async function getFileRecordById(
  fileId: number
): Promise<UploadedFileRecord | undefined> {
  const cached = fileRecords.get(fileId);
  if (cached) return cached;
  const rows = await pgQuery<{
    id: number;
    name: string;
    hash: string;
    ext: string;
    url: string;
    formats: unknown;
    width: number | null;
    height: number | null;
    provider: string;
    provider_metadata: unknown;
  }>(
    `SELECT id, name, hash, ext, url, formats, width, height, provider, provider_metadata
       FROM files
      WHERE id = $1`,
    [fileId]
  );
  if (!rows[0]) return undefined;
  const record: UploadedFileRecord = {
    id: rows[0].id,
    name: rows[0].name,
    hash: rows[0].hash,
    ext: rows[0].ext,
    url: rows[0].url,
    formats: parseFormats(rows[0].formats),
    width: rows[0].width,
    height: rows[0].height,
    provider: rows[0].provider,
    providerMetadata: rows[0].provider_metadata,
  };
  fileRecords.set(record.id, record);
  return record;
}

let uploadStats = { uploaded: 0, skipped: 0, failed: 0 };
const availabilityByFileId = new Map<number, Promise<boolean>>();
let s3KeyIndexPromise: Promise<Set<string>> | null = null;

function providerKey(value: unknown): string | null {
  if (!value) return null;
  let metadata = value;
  if (typeof value === "string") {
    try {
      metadata = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof metadata !== "object") return null;
  const key = (metadata as Record<string, unknown>).key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Load the configured migration prefix once. A full paginated LIST is much
 * cheaper than issuing a sequential HEAD request for every retained file, and
 * turns the rest of the migration's availability checks into local Set reads.
 */
async function getS3KeyIndex(): Promise<Set<string>> {
  if (s3KeyIndexPromise) return s3KeyIndexPromise;
  s3KeyIndexPromise = (async () => {
    const keys = new Set<string>();
    const prefix = config.s3.rootPath
      ? `${config.s3.rootPath.replace(/^\/+|\/+$/g, "")}/`
      : "";
    let continuationToken: string | undefined;
    let page = 0;
    logger.info(
      `S3 media delta: indexing existing objects under ` +
        `${prefix || "(bucket root)"}...`,
    );
    do {
      const response = await getS3Client().send(
        new ListObjectsV2Command({
          Bucket: config.s3.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      page += 1;
      for (const object of response.Contents ?? []) {
        if (object.Key) keys.add(object.Key);
      }
      continuationToken = response.NextContinuationToken;
      logger.info(
        `S3 media delta progress: page=${page}, indexed=${keys.size}, ` +
          `more=${continuationToken ? "yes" : "no"}`,
      );
    } while (continuationToken);
    logger.info(
      `S3 media delta: indexed ${keys.size} existing object(s) under ` +
        `${prefix || "(bucket root)"}`
    );
    return keys;
  })();
  return s3KeyIndexPromise;
}

/**
 * A retained files row is reusable only while its immutable master still
 * exists in S3. Results are cached because one file can be referenced by many
 * entities during one migration run.
 */
export async function isStoredFileAvailable(
  record: UploadedFileRecord | undefined
): Promise<boolean> {
  if (!record) return false;
  if (record.provider !== "aws-s3") return true;

  if (!config.s3.bucket || !config.s3.accessKeyId) {
    // We cannot verify or repair an AWS record without an AWS destination.
    // Retain the old behavior instead of creating a duplicate local record.
    return true;
  }

  const explicitKey = providerKey(record.providerMetadata);
  const rootPrefix = config.s3.rootPath
    ? `${config.s3.rootPath.replace(/^\/+|\/+$/g, "")}/`
    : "";
  const keyCandidates = explicitKey
    ? [explicitKey]
    : record.name && record.hash && record.ext
      ? mediaSourceResolution(
          {
            name: record.name,
            hash: record.hash,
            ext: record.ext,
          },
          rootPrefix,
        ).keyCandidates
      : [];
  if (keyCandidates.length === 0) return false;

  let task = availabilityByFileId.get(record.id);
  if (!task) {
    task = (async () => {
      const keys = await getS3KeyIndex();
      return keyCandidates.some((key) => keys.has(key));
    })();
    availabilityByFileId.set(record.id, task);
  }
  return task;
}

/**
 * Phase 2 — Preload hash cache only. Actual uploads happen on-demand
 * via uploadMediaOnDemand() when media is referenced by content.
 */
export async function runMediaUpload(): Promise<void> {
  logger.info("=== Phase 2: Media Upload (on-demand mode) ===");

  const inventory = getMediaInventory();
  if (inventory.size === 0) {
    logger.warn("No media inventory found. Run Phase 1 first.");
    return;
  }

  // Preload existing file hashes so on-demand uploads can skip duplicates
  await loadHashCache();
  logger.info(`Loaded ${existingHashes.size} existing file hashes`);
  logger.info(`Media inventory has ${inventory.size} items — uploads will happen on-demand when referenced`);
}

/** Source descriptor for a direct-from-disk upload (no attachment ID needed). */
export interface DiskUploadSource {
  localPath: string;
  fileName: string;
  mimeType: string;
  altText?: string | null;
  caption?: string | null;
  backgroundRemoval?: {
    sourceHash: string;
    version: string;
    removedAt: string;
  };
  /** Deal image failures abort the phase instead of becoming a missing field. */
  throwOnFailure?: boolean;
}

// In-flight uploads keyed by resolved local path, so concurrent posts
// referencing the same image share one upload instead of racing to duplicate.
const inFlightUploads = new Map<string, Promise<UploadedFileRecord | undefined>>();

/**
 * Called by resolveMediaRef when a media attachment is actually needed.
 * Creates the file record + uploads to S3 (or local) on first reference.
 * Returns the Strapi file ID, or undefined on failure.
 */
export async function uploadMediaOnDemand(attachmentId: number): Promise<number | undefined> {
  const record = await uploadMediaRecordOnDemand(attachmentId);
  return record?.id;
}

/**
 * Same as uploadMediaOnDemand but returns the full file record
 * (url/formats/dimensions), which content rewriting needs.
 */
export async function uploadMediaRecordOnDemand(
  attachmentId: number
): Promise<UploadedFileRecord | undefined> {
  const item = await getOrLoadMediaItem(attachmentId);
  if (!item || !item.localPath) return undefined;

  const record = await uploadFileFromDisk({
    localPath: item.localPath,
    fileName: item.fileName,
    mimeType: item.mimeType,
    altText: item.altText,
    caption: item.postTitle,
  });
  if (record) setMediaMapping(attachmentId, record.id);
  return record;
}

/**
 * Upload a file from disk through the optimize/S3 pipeline and insert its
 * files row. Deduplicates by content hash and by in-flight path.
 */
export async function uploadFileFromDisk(
  source: DiskUploadSource
): Promise<UploadedFileRecord | undefined> {
  const key = path.resolve(source.localPath);
  const pending = inFlightUploads.get(key);
  if (pending) return pending;

  const task = doUploadFileFromDisk(source).finally(() => {
    inFlightUploads.delete(key);
  });
  inFlightUploads.set(key, task);
  return task;
}

async function doUploadFileFromDisk(
  source: DiskUploadSource
): Promise<UploadedFileRecord | undefined> {
  await loadHashCache();

  try {
    const filePath = source.localPath;
    // One read serves both the hash and the upload body.
    const sourceBytes = fs.readFileSync(filePath);
    const hash = hashBuffer(sourceBytes);
    let repairExistingId: number | null = null;

    if (source.backgroundRemoval) {
      const existing = await pgQuery<{ id: number }>(
        `SELECT id
         FROM files
         WHERE background_removal_source_hash = $1
           AND background_removal_version = $2
         LIMIT 1`,
        [
          source.backgroundRemoval.sourceHash,
          source.backgroundRemoval.version,
        ],
      );
      if (existing[0]) {
        const record = await getFileRecordById(existing[0].id);
        if (await isStoredFileAvailable(record)) {
          uploadStats.skipped++;
          existingHashes.set(hash, existing[0].id);
          return record;
        }
        repairExistingId = existing[0].id;
      }
    }

    // The current files table is authoritative. A checkpoint's numeric file
    // ID can be stale after a dev DB reset, while the immutable source hash
    // still identifies the correct media record safely.
    if (existingHashes.has(hash)) {
      const existingId = existingHashes.get(hash)!;
      const record = await getFileRecordById(existingId);
      if (await isStoredFileAvailable(record)) {
        if (source.backgroundRemoval) {
          await pgQuery(
            `UPDATE files
             SET background_removal_source_hash = $2,
                 background_removal_version = $3,
                 background_removed_at = COALESCE(background_removed_at, $4)
             WHERE id = $1`,
            [
              existingId,
              source.backgroundRemoval.sourceHash,
              source.backgroundRemoval.version,
              source.backgroundRemoval.removedAt,
            ],
          );
        }
        uploadStats.skipped++;
        return record;
      }
      repairExistingId ??= existingId;
      logger.warn(
        `Media ${source.fileName} is indexed as file ${repairExistingId} ` +
          "but its S3 master is missing; regenerating and uploading it"
      );
      availabilityByFileId.delete(repairExistingId);
      fileRecords.delete(repairExistingId);
      if (source.backgroundRemoval) {
        await pgQuery(
          `UPDATE files
           SET background_removal_source_hash = $2,
               background_removal_version = $3,
               background_removed_at = COALESCE(background_removed_at, $4)
           WHERE id = $1`,
          [
            existingId,
            source.backgroundRemoval.sourceHash,
            source.backgroundRemoval.version,
            source.backgroundRemoval.removedAt,
          ],
        );
      }
    }

    // Do image decoding only for a new or missing S3 object. Retained media
    // that passed the hash + S3 availability delta above needs no processing.
    let backgroundColour: string | null = null;
    if (source.mimeType.startsWith("image/")) {
      try {
        backgroundColour = await calculateImageBackgroundColour(sourceBytes);
      } catch (error: any) {
        logger.warn(
          `Could not calculate background colour for ${source.fileName}: ${error.message}`
        );
      }
    }

    const sourceExt = getExtension(source.fileName);
    const nameWithoutExt = path.basename(source.fileName, sourceExt);
    const documentId = generateDocumentId();

    // Final file attributes — start with the source values, replaced by the
    // optimized output when optimization applies (S3 uploads only).
    let ext = sourceExt;
    let mime = source.mimeType;
    let { width, height } = await getImageDimensions(filePath, source.mimeType);
    let sizeInBytes = sourceBytes.length;
    let formatsJson: Record<string, any> | null = null;

    let fileUrl: string;
    let provider: string;
    let providerMetadata: string;

    if (config.s3.bucket && config.s3.accessKeyId) {
      // Upload to S3
      const client = getS3Client();
      const rootPath = config.s3.rootPath ? `${config.s3.rootPath}/` : "";
      // Pre-optimization source bytes — kept for AVIF twin generation, which
      // encodes from the highest-quality input available.
      const sourceBuffer: Buffer = sourceBytes;
      let uploadBuffer: Buffer = sourceBuffer;

      // Optimize supported raster formats: bake orientation, cap at 1920px,
      // convert jpeg/png → webp, recompress webp/avif/tiff. gif/svg/other
      // return null and pass through untouched (formats stays NULL).
      const optimized = OPTIMIZABLE_MIMES.has(source.mimeType)
        ? await optimizeOriginal(uploadBuffer)
        : null;
      if (optimized) {
        uploadBuffer = optimized.buffer;
        ext = optimized.ext;
        mime = optimized.mime;
        width = optimized.width;
        height = optimized.height;
        sizeInBytes = optimized.sizeInBytes;
      }

      // SEO-friendly layout: one folder per image so the original and all
      // generated variants live together, keyword-first filenames, and the
      // short content hash in the folder segment keeps URLs immutable:
      //   uploads/myntra-coupon-codes-a1b2c3d4/myntra-coupon-codes.webp
      //   uploads/myntra-coupon-codes-a1b2c3d4/large_myntra-coupon-codes.webp
      // NOTE: hash stays the sha256(source bytes)[0:16] of the ORIGINAL file
      // so dedupe/idempotency is untouched; only the extension may change.
      const slug = slugifyFileName(nameWithoutExt);
      const imageFolder = `${slug}-${hash.slice(0, 8)}`;
      const s3Key = `${rootPath}${imageFolder}/${slug}${ext}`;

      // `mime` for non-optimized files comes straight from WP metadata
      // (post_mime_type), which a compromised source could set to
      // image/svg+xml or text/html. An SVG (or HTML) served inline is stored
      // XSS. Optimized rasters carry a sharp-derived mime and are safe to
      // serve inline; anything else is forced to download instead of render.
      const safeToRenderInline = optimized !== null || mime.startsWith("image/");
      const isSvgOrMarkup =
        mime === "image/svg+xml" || mime === "text/html" || /\.svg$/i.test(ext);
      let contentType = mime;
      let contentDisposition: string | undefined;
      if (isSvgOrMarkup || !safeToRenderInline) {
        contentType = "application/octet-stream";
        contentDisposition = `attachment; filename="${slug}${ext}"`;
        logger.warn(
          `Media ${source.fileName} (${mime}) served as attachment to prevent inline script execution`
        );
      }

      await client.send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: s3Key,
          Body: uploadBuffer,
          ContentType: contentType,
          ContentDisposition: contentDisposition,
          CacheControl: "public, max-age=31536000, immutable",
        })
      );

      // Strapi's S3 provider stores the full URL when baseUrl is configured
      const urlPrefix = config.s3.baseUrl
        ? config.s3.baseUrl.replace(/\/+$/, "")
        : `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`;

      if (optimized && width && height) {
        const { formatsJson: generated, uploads } = await generateStrapiFormats(
          optimized.buffer,
          {
            width,
            height,
            ext,
            mime,
            hashBase: slug,
            nameBase: slug,
            urlPrefix,
            keyPrefix: `${rootPath}${imageFolder}/`,
            avifSource: sourceBuffer,
          }
        );
        for (const variant of uploads) {
          await client.send(
            new PutObjectCommand({
              Bucket: config.s3.bucket,
              Key: variant.key,
              Body: variant.buffer,
              ContentType: variant.contentType,
              CacheControl: "public, max-age=31536000, immutable",
            })
          );
        }
        formatsJson = generated;
      }

      fileUrl = `${urlPrefix}/${s3Key}`;
      provider = "aws-s3";
      providerMetadata = JSON.stringify({ key: s3Key });
    } else {
      // Local provider
      const hashedName = `${hash}_${nameWithoutExt}${ext}`;
      fileUrl = `/uploads/${hashedName}`;
      provider = "local";
      providerMetadata = JSON.stringify({ sourcePath: source.localPath });
    }

    const fileValues = [
      documentId,
      source.fileName,
      source.altText || null,
      source.caption || null,
      width,
      height,
      formatsJson ? JSON.stringify(formatsJson) : null,
      ext,
      mime,
      parseFloat((sizeInBytes / 1024).toFixed(2)),
      hash,
      fileUrl,
      provider,
      providerMetadata,
      backgroundColour,
      source.backgroundRemoval?.sourceHash ?? null,
      source.backgroundRemoval?.version ?? null,
      source.backgroundRemoval?.removedAt ?? null,
      "/",
    ];
    const result = repairExistingId
      ? await pgQuery<{ id: number }>(
          `UPDATE files
              SET name = $1,
                  alternative_text = $2,
                  caption = $3,
                  width = $4,
                  height = $5,
                  formats = $6,
                  ext = $7,
                  mime = $8,
                  size = $9,
                  hash = $10,
                  url = $11,
                  provider = $12,
                  provider_metadata = $13,
                  background_colour = $14,
                  background_removal_source_hash = $15,
                  background_removal_version = $16,
                  background_removed_at = $17,
                  folder_path = $18,
                  updated_at = NOW(),
                  published_at = COALESCE(published_at, NOW())
            WHERE id = $19
            RETURNING id`,
          [...fileValues.slice(1), repairExistingId]
        )
      : await pgQuery<{ id: number }>(
          `INSERT INTO files (
            document_id, name, alternative_text, caption, width, height,
            formats, ext, mime, size, hash, url, provider, provider_metadata,
            background_colour, background_removal_source_hash,
            background_removal_version, background_removed_at,
            folder_path, created_at, updated_at, published_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, NOW(), NOW(), NOW()
          ) RETURNING id`,
          fileValues
        );

    const fileId = result[0].id;
    existingHashes.set(hash, fileId);
    const record: UploadedFileRecord = {
      id: fileId,
      name: source.fileName,
      hash,
      ext,
      url: fileUrl,
      formats: formatsJson,
      width,
      height,
      provider,
      providerMetadata,
    };
    fileRecords.set(fileId, record);
    availabilityByFileId.set(fileId, Promise.resolve(true));
    if (provider === "aws-s3") {
      const key = providerKey(providerMetadata);
      if (key && s3KeyIndexPromise) {
        (await s3KeyIndexPromise).add(key);
      }
    }
    uploadStats.uploaded++;

    if (uploadStats.uploaded % 100 === 0) {
      logger.info(`  On-demand media: uploaded=${uploadStats.uploaded}, skipped=${uploadStats.skipped}`);
    }

    return record;
  } catch (err: any) {
    logger.error(`Failed to upload media ${source.fileName}: ${err.message}`);
    uploadStats.failed++;
    if (source.throwOnFailure) throw err;
    return undefined;
  }
}

export function logMediaUploadStats(): void {
  logger.info(`Media upload stats: uploaded=${uploadStats.uploaded}, skipped=${uploadStats.skipped}, failed=${uploadStats.failed}`);
}

/**
 * Delete all objects under the configured rootPath in the S3 bucket.
 * Called only by the explicit --clean --delete-media path.
 */
export async function clearS3Bucket(): Promise<void> {
  if (!config.s3.bucket || !config.s3.accessKeyId) {
    logger.info("S3 not configured, skipping bucket cleanup");
    return;
  }

  // Refuse to run with an empty prefix: that would delete EVERY object in the
  // bucket, including anything not created by this migration. Require an
  // explicit S3_ROOT_PATH to scope the deletion.
  const rootPath = config.s3.rootPath?.trim();
  if (!rootPath) {
    logger.warn(
      "S3_ROOT_PATH is empty — refusing to clear the entire bucket. " +
        "Set S3_ROOT_PATH (e.g. 'uploads') to scope --clean cleanup."
    );
    return;
  }

  const client = getS3Client();
  const prefix = `${rootPath}/`;
  let deleted = 0;
  let continuationToken: string | undefined;

  logger.info(`Clearing S3 bucket ${config.s3.bucket} (prefix: ${prefix})`);

  do {
    const listResponse = await client.send(
      new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = listResponse.Contents;
    if (!objects || objects.length === 0) break;

    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.s3.bucket,
        Delete: {
          Objects: objects.map((obj) => ({ Key: obj.Key })),
          Quiet: true,
        },
      })
    );

    deleted += objects.length;
    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  logger.info(`S3 cleanup complete: ${deleted} objects deleted`);
}
