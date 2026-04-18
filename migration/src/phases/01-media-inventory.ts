import fs from "fs";
import path from "path";
import { wpQuery } from "../db/wp-client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface MediaItem {
  attachmentId: number;
  guid: string;
  postTitle: string;
  mimeType: string;
  altText: string;
  localPath: string | null;
  fileName: string;
}

// Exported so Phase 2 can access
export let mediaInventory: Map<number, MediaItem> = new Map();

const SKIP_DIRS = [
  "backup", "ninja-popups", "elementor", "wpallimport", "wp-migrate-db",
  "sucuri", "wpcode", "awsm-job-openings", "ulp", "really-simple-ssl",
  "cp_preset_screenshots", "wpseo-redirects", "maxmegamenu",
];

export async function runMediaInventory(): Promise<void> {
  logger.info("=== Phase 1: Media Inventory ===");

  // Get only image attachments (skip backups, plugin files, etc.)
  const attachments = await wpQuery<{
    ID: number;
    guid: string;
    post_title: string;
    post_mime_type: string;
  }>(`
    SELECT ID, guid, post_title, post_mime_type
    FROM wp_posts
    WHERE post_type = 'attachment'
      AND post_mime_type LIKE 'image/%'
    ORDER BY ID
  `);

  logger.info(`Found ${attachments.length} image attachments in WordPress`);

  // Get alt text for all attachments in one query
  const altTexts = await wpQuery<{
    post_id: number;
    meta_value: string;
  }>(`
    SELECT post_id, meta_value
    FROM wp_postmeta
    WHERE meta_key = '_wp_attachment_image_alt'
    AND post_id IN (SELECT ID FROM wp_posts WHERE post_type = 'attachment')
  `);
  const altTextMap = new Map(altTexts.map((r) => [r.post_id, r.meta_value]));

  let localFound = 0;
  let localMissing = 0;
  let skippedPlugin = 0;

  for (const att of attachments) {
    // Extract relative path from guid
    // e.g., https://example.com/wp-content/uploads/2024/01/image.jpg -> 2024/01/image.jpg
    const guidUrl = att.guid;
    let relativePath = "";
    const uploadsIdx = guidUrl.indexOf("/uploads/");
    if (uploadsIdx !== -1) {
      relativePath = guidUrl.substring(uploadsIdx + "/uploads/".length);
    } else {
      // Try to extract filename from guid
      const urlParts = guidUrl.split("/");
      relativePath = urlParts[urlParts.length - 1];
    }

    // Skip files from plugin subdirectories (backups, ninja-popups, etc.)
    const firstSegment = relativePath.split("/")[0];
    if (SKIP_DIRS.includes(firstSegment)) {
      skippedPlugin++;
      continue;
    }

    const localPath = path.join(config.wpUploadsDir, relativePath);
    const exists = fs.existsSync(localPath);

    if (exists) {
      localFound++;
    } else {
      localMissing++;
    }

    const fileName = path.basename(relativePath);

    mediaInventory.set(att.ID, {
      attachmentId: att.ID,
      guid: att.guid,
      postTitle: att.post_title,
      mimeType: att.post_mime_type,
      altText: altTextMap.get(att.ID) || "",
      localPath: exists ? localPath : null,
      fileName,
    });
  }

  logger.info(`Media inventory complete:`);
  logger.info(`  Images found locally: ${localFound}`);
  logger.info(`  Images missing locally: ${localMissing}`);
  logger.info(`  Skipped (plugin dirs): ${skippedPlugin}`);
  logger.info(`  Total to upload: ${mediaInventory.size}`);
}

export function getMediaInventory(): Map<number, MediaItem> {
  return mediaInventory;
}

export async function getOrLoadMediaItem(
  attachmentId: number
): Promise<MediaItem | undefined> {
  const existing = mediaInventory.get(attachmentId);
  if (existing) return existing;

  const rows = await wpQuery<{
    ID: number;
    guid: string;
    post_title: string;
    post_mime_type: string;
    alt_text: string | null;
  }>(`
    SELECT
      p.ID,
      p.guid,
      p.post_title,
      p.post_mime_type,
      MAX(CASE WHEN pm.meta_key = '_wp_attachment_image_alt' THEN pm.meta_value END) AS alt_text
    FROM wp_posts p
    LEFT JOIN wp_postmeta pm ON p.ID = pm.post_id
    WHERE p.ID = ?
      AND p.post_type = 'attachment'
      AND p.post_mime_type LIKE 'image/%'
    GROUP BY p.ID, p.guid, p.post_title, p.post_mime_type
  `, [attachmentId]);

  const att = rows[0];
  if (!att) return undefined;

  const item = buildMediaItem(att);
  if (!item) return undefined;

  mediaInventory.set(attachmentId, item);
  return item;
}

function buildMediaItem(att: {
  ID: number;
  guid: string;
  post_title: string;
  post_mime_type: string;
  alt_text?: string | null;
}): MediaItem | undefined {
  const guidUrl = att.guid;
  let relativePath = "";
  const uploadsIdx = guidUrl.indexOf("/uploads/");
  if (uploadsIdx !== -1) {
    relativePath = guidUrl.substring(uploadsIdx + "/uploads/".length);
  } else {
    const urlParts = guidUrl.split("/");
    relativePath = urlParts[urlParts.length - 1];
  }

  const firstSegment = relativePath.split("/")[0];
  if (SKIP_DIRS.includes(firstSegment)) {
    return undefined;
  }

  const localPath = path.join(config.wpUploadsDir, relativePath);
  const exists = fs.existsSync(localPath);
  const fileName = path.basename(relativePath);

  return {
    attachmentId: att.ID,
    guid: att.guid,
    postTitle: att.post_title,
    mimeType: att.post_mime_type,
    altText: att.alt_text || "",
    localPath: exists ? localPath : null,
    fileName,
  };
}
