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
import { setMediaMapping, getMediaMapping } from "../utils/id-maps.js";
import { generateDocumentId } from "../utils/strapi-insert.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
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

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
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

// Cache of hash → strapi file id (to avoid duplicate uploads)
const existingHashes = new Map<string, number>();
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

let uploadStats = { uploaded: 0, skipped: 0, failed: 0 };

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

/**
 * Called by resolveMediaRef when a media attachment is actually needed.
 * Creates the file record + uploads to S3 (or local) on first reference.
 * Returns the Strapi file ID, or undefined on failure.
 */
export async function uploadMediaOnDemand(attachmentId: number): Promise<number | undefined> {
  // Already uploaded?
  const existing = getMediaMapping(attachmentId);
  if (existing) return existing;

  const item = await getOrLoadMediaItem(attachmentId);
  if (!item || !item.localPath) return undefined;

  await loadHashCache();

  try {
    const filePath = item.localPath;
    const hash = hashFile(filePath);

    // Skip if hash already exists in DB
    if (existingHashes.has(hash)) {
      const existingId = existingHashes.get(hash)!;
      setMediaMapping(attachmentId, existingId);
      uploadStats.skipped++;
      return existingId;
    }

    const fileStats = fs.statSync(filePath);
    const ext = getExtension(item.fileName);
    const nameWithoutExt = path.basename(item.fileName, ext);
    const { width, height } = await getImageDimensions(filePath, item.mimeType);
    const documentId = generateDocumentId();

    let fileUrl: string;
    let provider: string;
    let providerMetadata: string;

    if (config.s3.bucket && config.s3.accessKeyId) {
      // Upload to S3
      const client = getS3Client();
      const rootPath = config.s3.rootPath ? `${config.s3.rootPath}/` : "";
      const s3Key = `${rootPath}${hash}_${nameWithoutExt}${ext}`;
      const fileBuffer = fs.readFileSync(filePath);

      await client.send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: s3Key,
          Body: fileBuffer,
          ContentType: item.mimeType,
          CacheControl: "public, max-age=31536000, immutable",
        })
      );

      // Strapi's S3 provider stores the full URL when baseUrl is configured
      fileUrl = config.s3.baseUrl
        ? `${config.s3.baseUrl.replace(/\/+$/, "")}/${s3Key}`
        : `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${s3Key}`;
      provider = "aws-s3";
      providerMetadata = JSON.stringify({ key: s3Key });
    } else {
      // Local provider
      const hashedName = `${hash}_${nameWithoutExt}${ext}`;
      fileUrl = `/uploads/${hashedName}`;
      provider = "local";
      providerMetadata = JSON.stringify({ sourcePath: item.localPath });
    }

    const result = await pgQuery<{ id: number }>(
      `INSERT INTO files (
        document_id, name, alternative_text, caption, width, height,
        ext, mime, size, hash, url, provider, provider_metadata, folder_path,
        created_at, updated_at, published_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW(), NOW()
      ) RETURNING id`,
      [
        documentId,
        item.fileName,
        item.altText || null,
        item.postTitle || null,
        width,
        height,
        ext,
        item.mimeType,
        parseFloat((fileStats.size / 1024).toFixed(2)),
        hash,
        fileUrl,
        provider,
        providerMetadata,
        "/",
      ]
    );

    const fileId = result[0].id;
    setMediaMapping(attachmentId, fileId);
    existingHashes.set(hash, fileId);
    uploadStats.uploaded++;

    if (uploadStats.uploaded % 100 === 0) {
      logger.info(`  On-demand media: uploaded=${uploadStats.uploaded}, skipped=${uploadStats.skipped}`);
    }

    return fileId;
  } catch (err: any) {
    logger.error(`Failed to upload media ${item.fileName} (ID: ${attachmentId}): ${err.message}`);
    uploadStats.failed++;
    return undefined;
  }
}

export function logMediaUploadStats(): void {
  logger.info(`Media upload stats: uploaded=${uploadStats.uploaded}, skipped=${uploadStats.skipped}, failed=${uploadStats.failed}`);
}

/**
 * Delete all objects under the configured rootPath in the S3 bucket.
 * Called during --clean to avoid orphan files from previous runs.
 */
export async function clearS3Bucket(): Promise<void> {
  if (!config.s3.bucket || !config.s3.accessKeyId) {
    logger.info("S3 not configured, skipping bucket cleanup");
    return;
  }

  const client = getS3Client();
  const prefix = config.s3.rootPath ? `${config.s3.rootPath}/` : "";
  let deleted = 0;
  let continuationToken: string | undefined;

  logger.info(`Clearing S3 bucket ${config.s3.bucket} (prefix: ${prefix || "/"})`);

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
