/**
 * One-off S3 metadata repair: stamp the immutable Cache-Control header on
 * every already-uploaded media object.
 *
 * Background: actionOptions in cguruadmin/config/plugins.ts (and phase 14's
 * CACHE_CONTROL) only cover NEW puts — everything uploaded before those
 * changes serves with no Cache-Control at all, which is the "Cache TTL: None"
 * Lighthouse audit on the media host. Filenames are content-hashed and
 * overwrites are prevented, so a year-long immutable TTL is safe.
 *
 * A script instead of `aws s3 cp --metadata-directive REPLACE`: REPLACE swaps
 * ALL metadata, and the CLI re-guesses Content-Type from the file extension
 * on copy. This script HeadObjects first and carries the STORED Content-Type
 * (plus user metadata and content headers) through the in-place CopyObject,
 * changing nothing but Cache-Control. Objects already carrying the immutable
 * value are skipped, so re-runs are cheap and idempotent.
 *
 * Targets whatever the S3_* vars in migration/.env.migration resolve to —
 * i.e. the LIVE media bucket. Dry-run lists/heads only (read-only S3 calls);
 * applying requires an explicit confirmation flag matching that bucket (same
 * guard shape as fix-markdown-richtext):
 *
 *   yarn fix:cache-headers                                # dry-run
 *   yarn fix:cache-headers --apply --yes-i-mean-<bucket>  # write
 */

import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import pLimit from "p-limit";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { getS3Client } from "./phases/02-media-upload.js";
import { CACHE_CONTROL } from "./phases/14-media-optimize.js";

interface FixStats {
  scanned: number;
  alreadyImmutable: number;
  changed: number;
  failed: number;
}

async function processKey(
  client: ReturnType<typeof getS3Client>,
  key: string,
  apply: boolean,
  stats: FixStats
): Promise<void> {
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key })
    );
    if (head.CacheControl === CACHE_CONTROL) {
      stats.alreadyImmutable++;
      return;
    }

    stats.changed++;
    logger.info(
      `${apply ? "UPDATE" : "[dry-run] would update"} ${key} ` +
        `(Cache-Control: ${head.CacheControl ?? "<none>"} → immutable, ` +
        `Content-Type kept: ${head.ContentType ?? "<none>"})`
    );
    if (!apply) return;

    await client.send(
      new CopyObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        // CopySource is a URL path — encode everything except the separators.
        CopySource: `${config.s3.bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
        MetadataDirective: "REPLACE",
        CacheControl: CACHE_CONTROL,
        // REPLACE swaps ALL metadata: the stored content headers and user
        // metadata must ride along or the copy would wipe them.
        ContentType: head.ContentType,
        ContentDisposition: head.ContentDisposition,
        ContentEncoding: head.ContentEncoding,
        ContentLanguage: head.ContentLanguage,
        Metadata: head.Metadata,
      })
    );
  } catch (err: any) {
    stats.failed++;
    logger.error(`fix-cache-headers failed for ${key}: ${err?.message ?? err}`);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const bucket = config.s3.bucket;

  if (!bucket || !config.s3.accessKeyId) {
    logger.error("S3 is not configured (S3_BUCKET / S3_ACCESS_KEY_ID) — nothing to do");
    process.exitCode = 1;
    return;
  }

  logger.info(`fix-cache-headers target bucket: ${bucket} (${apply ? "APPLY" : "dry-run"})`);
  if (apply && !process.argv.includes(`--yes-i-mean-${bucket}`)) {
    logger.error(
      `Refusing to write: --apply rewrites object metadata on ${bucket}. ` +
        `Re-run with --yes-i-mean-${bucket} to confirm.`
    );
    process.exitCode = 1;
    return;
  }

  const client = getS3Client();
  const prefix = config.s3.rootPath ? `${config.s3.rootPath}/` : undefined;
  const limit = pLimit(config.mediaConcurrency || 10);
  const stats: FixStats = { scanned: 0, alreadyImmutable: 0, changed: 0, failed: 0 };
  const tasks: Promise<void>[] = [];

  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;

    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key || key.endsWith("/")) continue; // folder placeholder objects
      stats.scanned++;
      tasks.push(limit(() => processKey(client, key, apply, stats)));
    }
  } while (continuationToken);

  await Promise.all(tasks);

  logger.info(
    `fix-cache-headers complete: scanned=${stats.scanned}, ` +
      `already immutable=${stats.alreadyImmutable}, ` +
      `${apply ? "updated" : "would update (dry-run — pass --apply to write)"}=${stats.changed}, ` +
      `failed=${stats.failed}`
  );
  if (stats.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  logger.error(`fix-cache-headers failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
