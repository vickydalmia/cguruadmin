import { config } from "../config.js";
import { pgQuery } from "../db/pg-client.js";
import { loadFileManifest } from "./file-manifest.js";
import { logger } from "./logger.js";
import {
  decideMediaReuse,
  type FileManifestEntry,
} from "./manifest-core.js";
import { generateDocumentId } from "./strapi-insert.js";

type ManifestFilesRow = {
  document_id: string;
  name: string;
  alternative_text: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  formats: string | null;
  ext: string;
  mime: string;
  size: number;
  hash: string;
  url: string;
  provider: "aws-s3";
  provider_metadata: string;
  background_colour: string | null;
  background_removal_source_hash: string | null;
  background_removal_version: string | null;
  background_removed_at: string | null;
  folder_path: "/";
  created_at: string;
  updated_at: string;
  published_at: string;
};

export type UnreferencedManifestFile = {
  id: number;
  hash: string;
};

export function manifestEntryToFilesRow(
  hash: string,
  entry: FileManifestEntry,
  timestamp: string,
): ManifestFilesRow {
  return {
    document_id: generateDocumentId(`manifest-file:${hash}`),
    name: entry.name,
    alternative_text: entry.alternativeText,
    caption: entry.caption,
    width: entry.width,
    height: entry.height,
    formats: entry.formats ? JSON.stringify(entry.formats) : null,
    ext: entry.ext,
    mime: entry.mime,
    size: entry.sizeKb,
    hash,
    url: entry.url,
    provider: "aws-s3",
    provider_metadata: JSON.stringify(entry.providerMetadata),
    background_colour: entry.backgroundColour,
    background_removal_source_hash:
      entry.backgroundRemoval?.sourceHash ?? null,
    background_removal_version: entry.backgroundRemoval?.version ?? null,
    background_removed_at: entry.backgroundRemoval?.removedAt ?? null,
    folder_path: "/",
    created_at: timestamp,
    updated_at: timestamp,
    published_at: timestamp,
  };
}

async function insertManifestRows(rows: ManifestFilesRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0]) as Array<keyof ManifestFilesRow>;
  const chunkSize = Math.floor(65_535 / columns.length);
  let inserted = 0;

  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const result = await pgQuery<{ id: number }>(
      `INSERT INTO files (${columns.map((column) => `"${column}"`).join(", ")})
       VALUES ${tuples.join(", ")}
       ON CONFLICT DO NOTHING
       RETURNING id`,
      values,
    );
    inserted += result.length;
  }
  return inserted;
}

/**
 * Restore every reusable manifest-backed `files` row in a few multi-row
 * INSERTs before Phase 03 starts. S3 bytes stay untouched. This turns the
 * previous one-INSERT-per-taxonomy path into at most a handful of remote
 * PostgreSQL round trips.
 */
export async function restoreManifestFileRows(
  s3KeyIndex: ReadonlySet<string>,
): Promise<{ inserted: number; alreadyPresent: number; stale: number }> {
  if (!config.s3.bucket || !config.s3.accessKeyId) {
    return { inserted: 0, alreadyPresent: 0, stale: 0 };
  }

  const [manifest, existing] = await Promise.all([
    loadFileManifest(),
    pgQuery<{ hash: string }>(
      "SELECT hash FROM files WHERE hash IS NOT NULL",
    ),
  ]);
  const existingHashes = new Set(existing.map((row) => row.hash));
  const timestamp = new Date().toISOString();
  const rows: ManifestFilesRow[] = [];
  let alreadyPresent = 0;
  let stale = 0;

  for (const [hash, entry] of Object.entries(manifest.entries)) {
    if (existingHashes.has(hash)) {
      alreadyPresent++;
      continue;
    }
    const decision = decideMediaReuse({ manifestEntry: entry, s3KeyIndex });
    if (decision.action !== "manifest-reuse") {
      stale++;
      continue;
    }
    rows.push(manifestEntryToFilesRow(hash, decision.entry, timestamp));
  }

  const inserted = await insertManifestRows(rows);
  logger.info(
    `Manifest media bulk restore: inserted=${inserted}, ` +
      `already-present=${alreadyPresent}, stale=${stale}`,
  );
  return { inserted, alreadyPresent, stale };
}

/**
 * Locate only unused rows created by the bulk manifest restore. The
 * deterministic document id is the ownership boundary: ordinary Strapi media
 * and manually uploaded unlinked files are deliberately excluded.
 */
export async function findUnreferencedManifestFiles(): Promise<
  UnreferencedManifestFile[]
> {
  const manifest = await loadFileManifest();
  const documentIds = Object.keys(manifest.entries).map((hash) =>
    generateDocumentId(`manifest-file:${hash}`),
  );
  if (documentIds.length === 0) return [];

  const candidates: UnreferencedManifestFile[] = [];
  for (let start = 0; start < documentIds.length; start += 5_000) {
    const chunk = documentIds.slice(start, start + 5_000);
    candidates.push(
      ...(await pgQuery<UnreferencedManifestFile>(
        `SELECT file.id, file.hash
           FROM files file
          WHERE file.document_id = ANY($1::varchar[])
            AND NOT EXISTS (
              SELECT 1
                FROM files_related_mph relation
               WHERE relation.file_id = file.id
            )`,
        [chunk],
      )),
    );
  }
  return candidates;
}

/** Re-check relation absence at deletion time so a newly-linked row survives. */
export async function deleteUnreferencedManifestFiles(
  candidates: readonly UnreferencedManifestFile[],
): Promise<UnreferencedManifestFile[]> {
  if (candidates.length === 0) return [];
  const deleted: UnreferencedManifestFile[] = [];
  const ids = candidates.map((candidate) => candidate.id);
  for (let start = 0; start < ids.length; start += 5_000) {
    deleted.push(
      ...(await pgQuery<UnreferencedManifestFile>(
        `DELETE FROM files file
          WHERE file.id = ANY($1::integer[])
            AND NOT EXISTS (
              SELECT 1
                FROM files_related_mph relation
               WHERE relation.file_id = file.id
            )
        RETURNING file.id, file.hash`,
        [ids.slice(start, start + 5_000)],
      )),
    );
  }
  return deleted;
}
