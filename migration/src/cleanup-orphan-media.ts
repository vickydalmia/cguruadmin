import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
import { referencedKeysFromRow, type FilesRowLike } from "./utils/manifest-core.js";
import {
  FILES_ROW_SELECT,
  deleteS3Objects,
  listS3ObjectsWithSizes,
  manifestMirrorKey,
  pruneManifestEntries,
  s3RootPrefix,
  s3UrlPrefix,
  saveFileManifest,
  syncManifestFromDb,
  uploadManifestMirror,
} from "./utils/file-manifest.js";
import {
  deleteUnreferencedManifestFiles,
  findUnreferencedManifestFiles,
} from "./utils/manifest-file-restore.js";

/**
 * If more than this share of listed objects would be deleted, refuse without
 * --force-orphan-cleanup: a wrong PG_CONNECTION_STRING (or a DB holding only a
 * handful of rows) must not be able to hollow out the bucket.
 */
const MAX_ORPHAN_RATIO = 0.4;

export interface OrphanCleanupOptions {
  dryRun: boolean;
  force?: boolean;
}

/**
 * Phase 16 / `cleanup:orphan-media` — delete every object under the migration
 * root that no current `files` row references. Only meaningful AFTER a
 * successful full import: the files table is then the authoritative
 * description of what the site serves.
 */
export async function runOrphanMediaCleanup(
  options: OrphanCleanupOptions,
): Promise<void> {
  logger.info("=== Phase 16: Orphan media cleanup ===");

  if (!config.s3.bucket || !config.s3.accessKeyId) {
    logger.info("S3 not configured, skipping orphan cleanup");
    return;
  }
  const rootPrefix = s3RootPrefix();
  if (!rootPrefix) {
    // Mirrors clearS3Bucket: an empty prefix would consider EVERY object in
    // the bucket, including things this migration never created.
    logger.warn(
      "S3_ROOT_PATH is empty — refusing orphan cleanup over the whole bucket.",
    );
    return;
  }

  // One DB scan feeds both the manifest refresh and the referenced set.
  const { synced } = await syncManifestFromDb();
  logger.info(`Manifest refreshed from files table (${synced} row(s))`);

  const restoredCandidates = await findUnreferencedManifestFiles();
  const restoredCandidateIds = new Set(
    restoredCandidates.map((candidate) => candidate.id),
  );
  if (restoredCandidates.length > 0) {
    logger.info(
      `Manifest restore cleanup: ${restoredCandidates.length} unreferenced ` +
        `migration-owned files row(s) ${options.dryRun ? "would be pruned" : "eligible for pruning"}`,
    );
  }

  const urlPrefix = s3UrlPrefix();
  const rows = await pgQuery<FilesRowLike & { id: number }>(FILES_ROW_SELECT);
  const referenced = new Set<string>();
  for (const row of rows) {
    if (restoredCandidateIds.has(row.id)) continue;
    for (const key of referencedKeysFromRow(row, urlPrefix, rootPrefix)) {
      referenced.add(key);
    }
  }
  if (rows.length === 0 || referenced.size === 0) {
    logger.warn(
      "Refusing orphan cleanup: the files table references no S3 objects — " +
        "is PG_CONNECTION_STRING pointing at the imported database?",
    );
    return;
  }

  const listing = await listS3ObjectsWithSizes(rootPrefix);
  const bookkeepingPrefix = manifestMirrorKey().slice(
    0,
    manifestMirrorKey().lastIndexOf("/") + 1,
  );
  const orphans: string[] = [];
  let orphanBytes = 0;
  for (const [key, size] of listing) {
    if (key.startsWith(bookkeepingPrefix)) continue;
    if (referenced.has(key)) continue;
    orphans.push(key);
    orphanBytes += size;
  }

  logger.info(
    `Orphan scan: ${listing.size} object(s) listed, ${referenced.size} ` +
      `referenced, ${orphans.length} orphan(s) ` +
      `(${(orphanBytes / 1024 / 1024).toFixed(1)} MB)`,
  );
  if (orphans.length === 0) {
    if (!options.dryRun && restoredCandidates.length > 0) {
      const deletedRows = await deleteUnreferencedManifestFiles(
        restoredCandidates,
      );
      const deletedHashes = new Set(deletedRows.map((row) => row.hash));
      await pruneManifestEntries((hash) => !deletedHashes.has(hash));
      logger.info(
        `Pruned ${deletedRows.length} unreferenced manifest-restored files row(s)`,
      );
    }
    await saveFileManifest();
    await uploadManifestMirror();
    return;
  }

  const ratio = orphans.length / listing.size;
  if (ratio > MAX_ORPHAN_RATIO && !options.force) {
    logger.error(
      `Refusing to delete ${orphans.length}/${listing.size} objects ` +
        `(${Math.round(ratio * 100)}% > ${MAX_ORPHAN_RATIO * 100}% fuse). ` +
        "If this is genuinely expected, re-run with --force-orphan-cleanup.",
    );
    return;
  }

  const sample = orphans.slice(0, 10);
  for (const key of sample) logger.info(`  orphan: ${key}`);
  if (orphans.length > sample.length) {
    logger.info(`  ... and ${orphans.length - sample.length} more`);
  }

  if (options.dryRun) {
    logger.info("--dry-run: nothing deleted");
    return;
  }

  const deletedRows = await deleteUnreferencedManifestFiles(
    restoredCandidates,
  );
  await deleteS3Objects(orphans);
  logger.info(`Deleted ${orphans.length} orphan object(s)`);

  // Manifest entries whose master no longer exists are dead — prune them so
  // the reuse path never has to discover the staleness one miss at a time.
  const deleted = new Set(orphans);
  const deletedHashes = new Set(deletedRows.map((row) => row.hash));
  const pruned = await pruneManifestEntries(
    (hash, entry) =>
      !deletedHashes.has(hash) &&
      !entry.masterKeys.every((key) => deleted.has(key)),
  );
  if (pruned > 0) logger.info(`Pruned ${pruned} stale manifest entrie(s)`);
  if (deletedRows.length > 0) {
    logger.info(
      `Pruned ${deletedRows.length} unreferenced manifest-restored files row(s)`,
    );
  }

  await saveFileManifest();
  await uploadManifestMirror();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  try {
    await runOrphanMediaCleanup({
      dryRun: args.includes("--dry-run"),
      force: args.includes("--force-orphan-cleanup"),
    });
  } catch (err: any) {
    logger.error(`Orphan cleanup failed: ${err.message}`);
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
