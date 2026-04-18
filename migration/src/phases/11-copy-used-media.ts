import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pgQuery } from "../db/pg-client.js";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Strapi's public/uploads directory (relative to the migration package) */
const STRAPI_UPLOADS = path.resolve(__dirname, "../../../public/uploads");

/**
 * Phase 11 — Copy only the media files that are actually referenced by
 * entities (via files_related_mph) into Strapi's public/uploads directory.
 */
export async function runCopyUsedMedia(): Promise<void> {
  logger.info("=== Phase 11: Copy Used Media to public/uploads ===");

  // Ensure target directory exists
  if (!fs.existsSync(STRAPI_UPLOADS)) {
    fs.mkdirSync(STRAPI_UPLOADS, { recursive: true });
  }

  // Find files that are actually referenced by at least one entity
  const usedFiles = await pgQuery<{
    id: number;
    url: string;
    provider: string;
    provider_metadata: string | Record<string, any> | null;
  }>(`
    SELECT DISTINCT f.id, f.url, f.provider, f.provider_metadata
    FROM files f
    JOIN files_related_mph fmph ON f.id = fmph.file_id
    WHERE f.provider = 'local'
  `);

  logger.info(`Found ${usedFiles.length} used local files to copy`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of usedFiles) {
    try {
      // Extract source path from provider_metadata
      // pg driver auto-parses jsonb columns, so it may already be an object
      let sourcePath: string | null = null;
      if (file.provider_metadata) {
        const meta =
          typeof file.provider_metadata === "string"
            ? JSON.parse(file.provider_metadata)
            : file.provider_metadata;
        sourcePath = meta.sourcePath || null;
      }

      if (!sourcePath || !fs.existsSync(sourcePath)) {
        failed++;
        continue;
      }

      // Derive target filename from the URL (e.g. /uploads/abc123_image.jpg → abc123_image.jpg)
      const targetName = path.basename(file.url);
      const targetPath = path.join(STRAPI_UPLOADS, targetName);

      // Skip if already exists
      if (fs.existsSync(targetPath)) {
        skipped++;
        continue;
      }

      fs.copyFileSync(sourcePath, targetPath);
      copied++;

      if (copied % 200 === 0) {
        logger.info(`  Copied ${copied} files...`);
      }
    } catch (err: any) {
      logger.error(`Failed to copy file ${file.id} (${file.url}): ${err.message}`);
      failed++;
    }
  }

  logger.info(`Media copy complete: copied=${copied}, skipped=${skipped}, failed=${failed}`);
}
