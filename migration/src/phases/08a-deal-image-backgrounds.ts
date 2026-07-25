import fs from "fs";
import os from "os";
import path from "path";
import pLimit from "p-limit";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { pgQuery } from "../db/pg-client.js";
import { config } from "../config.js";
import {
  getS3Client,
  uploadFileFromDisk,
} from "./02-media-upload.js";
import {
  DEAL_IMAGE_PROCESSOR_VERSION,
  prepareMigrationDealImage,
} from "../utils/deal-image-background.js";
import { replaceMedia } from "../utils/strapi-insert.js";
import { logger } from "../utils/logger.js";

interface DealImageRow {
  deal_id: number;
  file_id: number;
  name: string;
  mime: string;
  url: string;
  provider: string;
  provider_metadata: unknown;
  formats: unknown;
  alternative_text: string | null;
  caption: string | null;
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
       f.mime,
       f.url,
       f.provider,
       f.provider_metadata,
       f.formats,
       f.alternative_text,
       f.caption
     FROM deals d
     JOIN files_related_mph relation
       ON relation.related_id = d.id
      AND relation.related_type = 'api::deal.deal'
      AND relation.field = 'dealImage'
     JOIN files f ON f.id = relation.file_id
     WHERE f.background_removal_version IS DISTINCT FROM $1
     ORDER BY d.id`,
    [DEAL_IMAGE_PROCESSOR_VERSION],
  );
  if (rows.length === 0) {
    logger.info("All Deal images already use the current transparent processor");
    return;
  }
  if (!config.fal.key) {
    throw new Error(
      `FAL_KEY is required to backfill ${rows.length} opaque Deal image(s)`,
    );
  }

  logger.info(`Found ${rows.length} Deal image relation(s) to process`);
  const limit = pLimit(Math.max(1, config.fal.concurrency));
  const replacedOpaque = new Map<number, DealImageRow>();
  let processed = 0;
  let completed = 0;
  const failures: string[] = [];

  await Promise.all(
    rows.map((row, index) =>
      limit(async () => {
        const progress = `${index + 1}/${rows.length}`;
        logger.info(
          `[deal-image ${progress}] processing deal=${row.deal_id}, ` +
            `source_file=${row.file_id}, name=${row.name}`,
        );
        const tempDirectory = fs.mkdtempSync(
          path.join(os.tmpdir(), "deal-image-backfill-"),
        );
        try {
          const localPath = await downloadSource(row, tempDirectory);
          const prepared = await prepareMigrationDealImage({
            localPath,
            fileName: row.name,
            mimeType: row.mime,
            altText: row.alternative_text,
            caption: row.caption,
          });
          const transparent = await uploadFileFromDisk({
            localPath: prepared.pngPath,
            fileName: `${row.name.replace(/\.[^.]+$/, "")}-transparent.png`,
            mimeType: "image/png",
            altText: row.alternative_text,
            caption: row.caption,
            backgroundRemoval: {
              sourceHash: prepared.sourceHash,
              version: DEAL_IMAGE_PROCESSOR_VERSION,
              removedAt: new Date().toISOString(),
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
              `archive=${prepared.reusedArchive ? "reused" : "written"}, ` +
              `source=${
                prepared.reusedArchive
                  ? "local-transparent-archive"
                  : prepared.skippedProvider
                    ? "already-transparent-original"
                    : "fal-api"
              }`,
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
            `[deal-image progress ${completed}/${rows.length}] ` +
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
    throw new Error(
      `${failures.length} Deal image(s) failed background removal; ` +
        `rerun --phase 08a-deal-image-backgrounds after resolving the API error`,
    );
  }
}
