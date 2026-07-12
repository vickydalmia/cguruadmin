import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { wpQuery } from "../db/wp-client.js";
import { config } from "../config.js";
import {
  uploadFileFromDisk,
  uploadMediaRecordOnDemand,
  UploadedFileRecord,
} from "../phases/02-media-upload.js";
import { logger } from "./logger.js";

/**
 * Rewrites WordPress uploads URLs embedded in rich-text HTML (img src/srcset,
 * lightbox <a href>, etc.) to the migrated S3/local URLs, uploading each
 * referenced image on demand through the optimize pipeline.
 */

/** Extension → MIME for uploads-dir files that have no attachment row. */
const IMAGE_MIMES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

// ── Reverse index: uploads-relative path → WP attachment ID ─────────────

let indexPromise: Promise<Map<string, number>> | null = null;

function getAttachedFileIndex(): Promise<Map<string, number>> {
  if (!indexPromise) {
    indexPromise = buildAttachedFileIndex();
  }
  return indexPromise;
}

async function buildAttachedFileIndex(): Promise<Map<string, number>> {
  const rows = await wpQuery<{ post_id: number; meta_value: string }>(`
    SELECT pm.post_id, pm.meta_value
    FROM wp_postmeta pm
    JOIN wp_posts p ON p.ID = pm.post_id AND p.post_type = 'attachment'
    WHERE pm.meta_key = '_wp_attached_file'
  `);

  const index = new Map<string, number>();
  for (const row of rows) {
    const rel = (row.meta_value || "").trim().replace(/^\/+/, "");
    if (!rel) continue;
    if (!index.has(rel)) index.set(rel, row.post_id);
    // WP ≥5.3 stores big originals as foo-scaled.jpg while content may
    // reference foo.jpg — index the unscaled alias too.
    const scaled = rel.match(/^(.*)-scaled(\.\w+)$/i);
    if (scaled) {
      const unscaled = `${scaled[1]}${scaled[2]}`;
      if (!index.has(unscaled)) index.set(unscaled, row.post_id);
    }
  }
  logger.info(`Content media: indexed ${index.size} attachment file paths`);
  return index;
}

// ── URL → uploads-relative path normalization ───────────────────────────

/** Extracts the path after /wp-content/uploads/ from any absolute or
 *  site-relative URL, dropping query string/fragment. Null if not an
 *  uploads URL. */
export function extractUploadsRelPath(url: string): string | null {
  const unescaped = url.replace(/&amp;/g, "&");
  const idx = unescaped.indexOf("/wp-content/uploads/");
  if (idx === -1) return null;
  const rel = unescaped
    .substring(idx + "/wp-content/uploads/".length)
    .split(/[?#]/)[0]
    .replace(/^\/+/, "");
  return rel || null;
}

/** Lookup candidates for a referenced path: as-is, with the WP size suffix
 *  (-300x200) stripped, and with -scaled added/removed. Originals are
 *  ordered before sized crops. */
function candidateRelPaths(rawPath: string): string[] {
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // keep raw path if percent-encoding is malformed
  }

  const out: string[] = [];
  const push = (p: string) => {
    if (p && !out.includes(p)) out.push(p);
  };

  const sized = decoded.match(/^(.*)-\d+x\d+(\.\w+)$/);
  if (sized) push(`${sized[1]}${sized[2]}`);
  push(decoded);

  for (const p of [...out]) {
    const scaled = p.match(/^(.*)-scaled(\.\w+)$/i);
    if (scaled) {
      push(`${scaled[1]}${scaled[2]}`);
    } else {
      const ext = p.match(/^(.*)(\.\w+)$/);
      if (ext) push(`${ext[1]}-scaled${ext[2]}`);
    }
  }
  return out;
}

// ── Resolution (with per-path caching) ───────────────────────────────────

const resolvedByPath = new Map<string, Promise<UploadedFileRecord | undefined>>();
const missedPaths = new Set<string>();

let stats = { imagesRewritten: 0, urlsRewritten: 0 };

/** Resolves a WP uploads URL to a migrated file record, uploading on demand. */
export async function resolveUploadsUrl(
  url: string
): Promise<UploadedFileRecord | undefined> {
  const rel = extractUploadsRelPath(url);
  if (!rel) return undefined;

  let task = resolvedByPath.get(rel);
  if (!task) {
    task = resolveRelPath(rel, url);
    resolvedByPath.set(rel, task);
  }
  return task;
}

async function resolveRelPath(
  rel: string,
  sourceUrl: string
): Promise<UploadedFileRecord | undefined> {
  const index = await getAttachedFileIndex();
  const candidates = candidateRelPaths(rel);

  for (const candidate of candidates) {
    const attachmentId = index.get(candidate);
    if (attachmentId) {
      const record = await uploadMediaRecordOnDemand(attachmentId);
      if (record) return record;
    }
  }

  // No attachment row (or its upload failed) — upload straight from the
  // uploads dir so content images without a media-library entry still make it.
  // Root-level files sometimes only survive under uploads/backup/, so check
  // there too.
  const uploadsRoot = path.resolve(config.wpUploadsDir);
  const diskCandidates = candidates.flatMap((c) => [c, `backup/${c}`]);
  for (const candidate of diskCandidates) {
    const localPath = path.resolve(uploadsRoot, candidate);
    // Traversal guard: candidate comes from post content, reject escapes.
    if (localPath !== uploadsRoot && !localPath.startsWith(uploadsRoot + path.sep)) {
      continue;
    }
    if (!fs.existsSync(localPath)) continue;
    const mime = IMAGE_MIMES[path.extname(localPath).toLowerCase()];
    if (!mime) continue;
    return uploadFileFromDisk({
      localPath,
      fileName: path.basename(localPath),
      mimeType: mime,
    });
  }

  // Last resort: the file is gone from the local uploads tree but the old
  // site/CDN may still serve it — download and push through the pipeline.
  return fetchRemoteAndUpload(sourceUrl, candidates);
}

const __contentMediaDir = path.dirname(fileURLToPath(import.meta.url));
/** Downloaded remote originals are kept here so re-runs don't re-fetch. */
const REMOTE_MEDIA_DIR = path.resolve(__contentMediaDir, "../../.checkpoints/remote-media");

async function fetchRemoteAndUpload(
  sourceUrl: string,
  candidates: string[]
): Promise<UploadedFileRecord | undefined> {
  const unescaped = sourceUrl.replace(/&amp;/g, "&");
  if (!/^https?:\/\//i.test(unescaped)) return undefined;
  const idx = unescaped.indexOf("/wp-content/uploads/");
  if (idx === -1) return undefined;
  const urlPrefix = unescaped.substring(0, idx + "/wp-content/uploads/".length);

  for (const candidate of candidates) {
    const mime = IMAGE_MIMES[path.extname(candidate).toLowerCase()];
    if (!mime) continue;

    const localPath = path.resolve(REMOTE_MEDIA_DIR, candidate);
    if (localPath !== REMOTE_MEDIA_DIR && !localPath.startsWith(REMOTE_MEDIA_DIR + path.sep)) {
      continue;
    }

    if (!fs.existsSync(localPath)) {
      const remoteUrl = urlPrefix + candidate.split("/").map(encodeURIComponent).join("/");
      let buffer: Buffer;
      try {
        const res = await fetch(remoteUrl, {
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) continue;
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) continue;
        buffer = Buffer.from(await res.arrayBuffer());
      } catch {
        continue;
      }
      if (buffer.length === 0) continue;
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, buffer);
      logger.info(`Content media: downloaded missing file from ${remoteUrl}`);
    }

    return uploadFileFromDisk({
      localPath,
      fileName: path.basename(candidate),
      mimeType: mime,
    });
  }

  return undefined;
}

function reportMiss(url: string): void {
  const rel = extractUploadsRelPath(url) || url;
  if (missedPaths.has(rel)) return;
  missedPaths.add(rel);
  logger.warn(`Content media not resolved, URL left as-is: ${url.substring(0, 140)}`);
}

// ── HTML rewriting ───────────────────────────────────────────────────────

export interface ContentMediaResult {
  html: string | null;
  /** Strapi file IDs referenced by the rewritten HTML (for morph linking). */
  fileIds: number[];
}

function getAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2]) : undefined;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const SRCSET_FORMAT_KEYS = ["thumbnail", "small", "medium", "large"];

function buildSrcset(record: UploadedFileRecord): string | null {
  const entries: Array<{ url: string; width: number }> = [];
  const formats = record.formats || {};
  for (const key of SRCSET_FORMAT_KEYS) {
    const f = formats[key];
    if (f?.url && f?.width) entries.push({ url: f.url, width: f.width });
  }
  if (record.url && record.width) {
    entries.push({ url: record.url, width: record.width });
  }
  if (entries.length < 2) return null;
  entries.sort((a, b) => a.width - b.width);
  return entries.map((e) => `${e.url} ${e.width}w`).join(", ");
}

function rebuildImgTag(tag: string, record: UploadedFileRecord): string {
  const attrs: string[] = [`src="${escapeAttr(record.url)}"`];

  const srcset = buildSrcset(record);
  if (srcset && record.width) {
    attrs.push(`srcset="${escapeAttr(srcset)}"`);
    attrs.push(`sizes="(max-width: ${record.width}px) 100vw, ${record.width}px"`);
  }

  attrs.push(`alt="${escapeAttr(getAttr(tag, "alt") ?? "")}"`);
  for (const name of ["title", "class", "id"]) {
    const val = getAttr(tag, name);
    if (val !== undefined) attrs.push(`${name}="${escapeAttr(val)}"`);
  }
  if (record.width && record.height) {
    attrs.push(`width="${record.width}"`, `height="${record.height}"`);
  }
  attrs.push(`loading="${escapeAttr(getAttr(tag, "loading") ?? "lazy")}"`);

  return `<img ${attrs.join(" ")} />`;
}

// Host part excludes '/' so an outer redirect/proxy URL that embeds an
// uploads URL in its query string is never swallowed whole — only the inner
// uploads URL itself matches.
const UPLOADS_URL_RE =
  /(?:https?:\/\/[^"'\s<>/]+)?\/wp-content\/uploads\/[^"'\s<>]+/g;

/**
 * Rewrites every WP uploads reference in sanitized HTML to the migrated URL.
 * <img> tags get rebuilt with an optimized src + responsive srcset from the
 * generated Strapi formats; other references (e.g. <a href>) are swapped
 * in place. Unresolvable URLs are left untouched and logged.
 */
export async function rewriteContentMedia(
  html: string | null
): Promise<ContentMediaResult> {
  if (!html || !html.includes("/wp-content/uploads/")) {
    return { html, fileIds: [] };
  }

  const fileIds = new Set<number>();
  let out = html;

  // Pass 1: rebuild <img> tags whose src points at WP uploads. This also
  // clears their stale srcset/sizes attributes in one shot.
  const imgReplacements = new Map<string, string>();
  for (const match of html.matchAll(/<img\b[^>]*\/?>/gi)) {
    const tag = match[0];
    if (imgReplacements.has(tag)) continue;
    const src = getAttr(tag, "src");
    if (!src || !src.includes("/wp-content/uploads/")) continue;
    const record = await resolveUploadsUrl(src);
    if (!record) {
      reportMiss(src);
      continue;
    }
    fileIds.add(record.id);
    imgReplacements.set(tag, rebuildImgTag(tag, record));
    stats.imagesRewritten++;
  }
  for (const [oldTag, newTag] of imgReplacements) {
    out = out.split(oldTag).join(newTag);
  }

  // Pass 2: remaining uploads URLs (lightbox links, unresolved-img srcset
  // siblings, etc.). Longest first so a URL that prefixes another can't
  // corrupt it mid-replace.
  const urls = [...new Set(out.match(UPLOADS_URL_RE) || [])].sort(
    (a, b) => b.length - a.length
  );
  for (const url of urls) {
    const record = await resolveUploadsUrl(url);
    if (!record) {
      reportMiss(url);
      continue;
    }
    fileIds.add(record.id);
    out = out.split(url).join(record.url);
    stats.urlsRewritten++;
  }

  return { html: out, fileIds: [...fileIds] };
}

export function logContentMediaStats(): void {
  logger.info(
    `Content media stats: img tags rewritten=${stats.imagesRewritten}, ` +
      `other URLs rewritten=${stats.urlsRewritten}, unresolved=${missedPaths.size}`
  );
  if (missedPaths.size > 0) {
    logger.warn(`Unresolved content media paths (${missedPaths.size}):`);
    for (const p of missedPaths) logger.warn(`  - ${p}`);
  }
}
