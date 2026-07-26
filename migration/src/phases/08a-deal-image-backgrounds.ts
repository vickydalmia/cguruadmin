import fs from "fs";
import os from "os";
import path from "path";
import pLimit from "p-limit";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { pgQuery } from "../db/pg-client.js";
import { config } from "../config.js";
import {
  getS3Client,
  isStoredFileAvailable,
  uploadFileFromDisk,
} from "./02-media-upload.js";
import {
  DEAL_IMAGE_ARCHIVE_DIR,
  DEAL_IMAGE_PROCESSOR_VERSION,
  prepareMigrationDealImage,
} from "../utils/deal-image-background.js";
import { buildLocalHashMap } from "./14-media-optimize.js";
import { replaceMedia } from "../utils/strapi-insert.js";
import { logger } from "../utils/logger.js";
import { resolveBackfillRemovalTimestamp } from "../utils/deal-image-backfill-state.js";
import { allowsPartialDeals } from "../utils/phase-outcome.js";

interface DealImageRow {
  deal_id: number;
  file_id: number;
  name: string;
  hash: string;
  ext: string;
  mime: string;
  url: string;
  provider: string;
  provider_metadata: unknown;
  formats: unknown;
  alternative_text: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  background_removal_source_hash: string | null;
  background_removal_version: string | null;
  background_removed_at: string | null;
}

const parseJson = (value: unknown): Record<string, any> => {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, any>;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
};

const SOURCE_MIMES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

function archivedTransparentPath(row: DealImageRow): string | null {
  const sourceHash = row.background_removal_source_hash;
  if (!sourceHash || !fs.existsSync(DEAL_IMAGE_ARCHIVE_DIR)) return null;
  try {
    const name = fs
      .readdirSync(DEAL_IMAGE_ARCHIVE_DIR)
      .find((entry) => entry.startsWith(`${sourceHash}-`) && entry.endsWith(".png"));
    return name ? path.join(DEAL_IMAGE_ARCHIVE_DIR, name) : null;
  } catch {
    return null;
  }
}

async function downloadSource(row: DealImageRow, directory: string): Promise<string> {
  const metadata = parseJson(row.provider_metadata);
  if (
    row.provider === "local" &&
    typeof metadata.sourcePath === "string" &&
    fs.existsSync(metadata.sourcePath)
  ) {
    return metadata.sourcePath;
  }

  if (!/^https?:\/\//i.test(row.url)) {
    throw new Error(`File ${row.file_id} has no readable local source or public URL`);
  }
  const response = await fetch(row.url);
  if (!response.ok) {
    throw new Error(`File ${row.file_id} download returned ${response.status}`);
  }
  const extension = path.extname(row.name) || ".img";
  const localPath = path.join(directory, `source-${row.file_id}${extension}`);
  fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
  return localPath;
}

function s3KeyFromUrl(url: string): string | null {
  const baseUrl = config.s3.baseUrl.replace(/\/+$/, "");
  if (baseUrl && url.startsWith(`${baseUrl}/`)) {
    return url.slice(baseUrl.length + 1);
  }
  try {
    return new URL(url).pathname.replace(/^\/+/, "") || null;
  } catch {
    return null;
  }
}

async function deleteUnreferencedOpaqueFile(row: DealImageRow): Promise<boolean> {
  const references = await pgQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM files_related_mph
     WHERE file_id = $1`,
    [row.file_id],
  );
  if (Number(references[0]?.count ?? 0) > 0) return false;

  if (
    row.provider === "aws-s3" &&
    config.s3.bucket &&
    config.s3.accessKeyId
  ) {
    const metadata = parseJson(row.provider_metadata);
    const formats = parseJson(row.formats);
    const keys = new Set<string>();
    if (typeof metadata.key === "string") keys.add(metadata.key);
    for (const format of Object.values(formats)) {
      const key =
        format && typeof format === "object"
          ? s3KeyFromUrl(String((format as any).url ?? ""))
          : null;
      if (key) keys.add(key);
    }

    const requiredPrefix = `${config.s3.rootPath.replace(/^\/+|\/+$/g, "")}/`;
    const safeKeys = [...keys].filter(
      (key) => requiredPrefix !== "/" && key.startsWith(requiredPrefix),
    );
    if (safeKeys.length !== keys.size) {
      logger.warn(
        `Retaining opaque file ${row.file_id}: one or more S3 keys are outside ${requiredPrefix}`,
      );
      return false;
    }
    if (safeKeys.length > 0) {
      await getS3Client().send(
        new DeleteObjectsCommand({
          Bucket: config.s3.bucket,
          Delete: {
            Objects: safeKeys.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }

  await pgQuery(`DELETE FROM files WHERE id = $1`, [row.file_id]);
  return true;
}

export async function runDealImageBackgroundBackfill(): Promise<void> {
  logger.info("=== Phase 8a: Transparent Deal Image Backfill ===");
  const rows = await pgQuery<DealImageRow>(
    `SELECT
       d.id AS deal_id,
       f.id AS file_id,
       f.name,
       f.hash,
       f.ext,
       f.mime,
       f.url,
       f.provider,
       f.provider_metadata,
       f.formats,
       f.alternative_text,
       f.caption,
       f.width,
       f.height,
       f.background_removal_source_hash,
       f.background_removal_version,
       f.background_removed_at
     FROM deals d
     JOIN files_related_mph relation
       ON relation.related_id = d.id
      AND relation.related_type = 'api::deal.deal'
      AND relation.field = 'dealImage'
     JOIN files f ON f.id = relation.file_id
     ORDER BY d.id`,
  );
  logger.info(
    `Deal image backfill: loaded ${rows.length} relation(s); ` +
      `checking processor version and S3 availability`,
  );
  const availabilityLimit = pLimit(Math.max(1, config.mediaConcurrency));
  let availabilityChecked = 0;
  const candidateResults = await Promise.all(
    rows.map((row) =>
      availabilityLimit(async () => {
        try {
          if (row.background_removal_version !== DEAL_IMAGE_PROCESSOR_VERSION) {
            return { row, repairMissingS3: false };
          }
          const available = await isStoredFileAvailable({
            id: row.file_id,
            name: row.name,
            hash: row.hash,
            ext: row.ext,
            url: row.url,
            formats: parseJson(row.formats),
            width: row.width,
            height: row.height,
            provider: row.provider,
            providerMetadata: row.provider_metadata,
          });
          return available ? null : { row, repairMissingS3: true };
        } finally {
          availabilityChecked += 1;
          if (
            availabilityChecked % 100 === 0 ||
            availabilityChecked === rows.length
          ) {
            logger.info(
              `Deal image availability progress: ` +
                `${availabilityChecked}/${rows.length} checked`,
            );
          }
        }
      }),
    ),
  );
  const candidates = candidateResults.filter(
    (candidate): candidate is { row: DealImageRow; repairMissingS3: boolean } =>
      candidate !== null,
  );
  if (candidates.length === 0) {
    logger.info("All Deal images already use the current transparent processor");
    return;
  }
  const missingS3Count = candidates.filter(
    (candidate) => candidate.repairMissingS3,
  ).length;
  logger.info(
    `Found ${candidates.length} Deal image relation(s) to process` +
      (missingS3Count > 0 ? ` (${missingS3Count} missing from S3)` : ""),
  );
  const limit = pLimit(Math.max(1, config.fal.concurrency));
  const replacedOpaque = new Map<number, DealImageRow>();
  let localSourcesByHash: Map<string, string> | null = null;
  let processed = 0;
  let completed = 0;
  const failures: string[] = [];

  await Promise.all(
    candidates.map(({ row, repairMissingS3 }, index) =>
      limit(async () => {
        const progress = `${index + 1}/${candidates.length}`;
        logger.info(
          `[deal-image ${progress}] processing deal=${row.deal_id}, ` +
            `source_file=${row.file_id}, name=${row.name}`,
        );
        const tempDirectory = fs.mkdtempSync(
          path.join(os.tmpdir(), "deal-image-backfill-"),
        );
        try {
          const archivedPath = repairMissingS3
            ? archivedTransparentPath(row)
            : null;
          let prepared:
            | Awaited<ReturnType<typeof prepareMigrationDealImage>>
            | null = null;
          let uploadPath: string;
          let uploadName: string;
          let sourceHash: string;
          let sourceLabel: string;
          let reusedTransparentOutput = false;

          if (archivedPath && row.background_removal_source_hash) {
            uploadPath = archivedPath;
            uploadName = `${row.name.replace(/\.[^.]+$/, "")}-transparent.png`;
            sourceHash = row.background_removal_source_hash;
            sourceLabel = "local-transparent-archive";
            reusedTransparentOutput = true;
          } else {
            let localPath: string;
            let mimeType = row.mime;
            if (repairMissingS3 && row.background_removal_source_hash) {
              localSourcesByHash ??= buildLocalHashMap();
              const original = localSourcesByHash.get(
                row.background_removal_source_hash.slice(0, 16),
              );
              if (!original) {
                throw new Error(
                  `S3 object and local transparent archive are missing, and ` +
                    `no WordPress source matches ${row.background_removal_source_hash}`,
                );
              }
              localPath = original;
              mimeType =
                SOURCE_MIMES[path.extname(original).toLowerCase()] ?? row.mime;
            } else {
              localPath = await downloadSource(row, tempDirectory);
            }
            prepared = await prepareMigrationDealImage({
              localPath,
              fileName: path.basename(localPath),
              mimeType,
              altText: row.alternative_text,
              caption: row.caption,
            });
            uploadPath = prepared.pngPath;
            uploadName = `${row.name.replace(/\.[^.]+$/, "")}-transparent.png`;
            sourceHash = prepared.sourceHash;
            reusedTransparentOutput = prepared.reusedArchive;
            sourceLabel = prepared.reusedArchive
              ? "local-transparent-archive"
              : prepared.skippedProvider
                ? "already-transparent-original"
                : "fal-api";
          }
          const transparent = await uploadFileFromDisk({
            localPath: uploadPath,
            fileName: uploadName,
            mimeType: "image/png",
            altText: row.alternative_text,
            caption: row.caption,
            backgroundRemoval: {
              sourceHash,
              version: DEAL_IMAGE_PROCESSOR_VERSION,
              removedAt: resolveBackfillRemovalTimestamp({
                repairMissingS3,
                reusedTransparentOutput,
                previousRemovedAt: row.background_removed_at,
                processedAt: new Date().toISOString(),
              }),
            },
            throwOnFailure: true,
          });
          if (!transparent) {
            throw new Error("Transparent image upload returned no file");
          }
          await replaceMedia(
            transparent.id,
            row.deal_id,
            "api::deal.deal",
            "dealImage",
          );
          replacedOpaque.set(row.file_id, row);
          processed += 1;
          logger.info(
            `[deal-image ${progress}] complete: deal=${row.deal_id}, ` +
              `transparent_file=${transparent.id}, ` +
              `archive=${prepared?.reusedArchive || archivedPath ? "reused" : "written"}, ` +
              `source=${sourceLabel}`,
          );
        } catch (error: any) {
          failures.push(`deal ${row.deal_id} / file ${row.file_id}: ${error.message}`);
          logger.error(
            `[deal-image ${progress}] failed: deal=${row.deal_id}, ` +
              `source_file=${row.file_id}, error=${error.message}`,
          );
        } finally {
          completed += 1;
          logger.info(
            `[deal-image progress ${completed}/${candidates.length}] ` +
              `processed=${processed}, failed=${failures.length}`,
          );
          fs.rmSync(tempDirectory, { recursive: true, force: true });
        }
      }),
    ),
  );

  let deleted = 0;
  let retained = 0;
  const opaqueFiles = [...replacedOpaque.values()];
  logger.info(
    `Starting old opaque-file cleanup for ${opaqueFiles.length} replaced file(s)`,
  );
  for (const [index, row] of opaqueFiles.entries()) {
    try {
      if (await deleteUnreferencedOpaqueFile(row)) deleted += 1;
      else retained += 1;
    } catch (error: any) {
      retained += 1;
      logger.warn(
        `Could not remove unreferenced opaque file ${row.file_id}: ${error.message}`,
      );
    }
    const checked = index + 1;
    if (checked % 25 === 0 || checked === opaqueFiles.length) {
      logger.info(
        `[deal-image cleanup ${checked}/${opaqueFiles.length}] ` +
          `deleted=${deleted}, retained=${retained}`,
      );
    }
  }

  logger.info(
    `Deal image backfill complete: ${processed} relation(s), ` +
      `${deleted} unreferenced opaque file(s) deleted, ${retained} retained`,
  );
  if (failures.length > 0) {
    const message =
      `${failures.length} Deal image(s) failed background removal; ` +
      `rerun --phase 08a-deal-image-backgrounds after resolving the API error`;
    if (allowsPartialDeals()) {
      logger.warn(
        `${message}. Continuing because --allow-partial-deals was provided`,
      );
      return;
    }
    throw new Error(message);
  }
}
