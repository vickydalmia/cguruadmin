import type { UploadedFileRecord } from "../phases/02-media-upload.js";
import { IMAGE_BREAKPOINTS } from "./image-optimizer.js";

/**
 * Pure <img>-tag helpers shared by the migration content rewrite
 * (content-media.ts, which re-exports them) and fix-content-srcsets. Kept free
 * of config/db imports so the tsx test suite can load it without
 * .env.migration.
 */

export function getAttr(tag: string, name: string): string | undefined {
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

// buildSrcset sorts by width, so declaration order is irrelevant.
const SRCSET_FORMAT_KEYS = ["thumbnail", ...Object.keys(IMAGE_BREAKPOINTS)];

/** Width-sorted srcset from a file record's formats + original (exported for
 *  fix-content-srcsets, which rebuilds stored HTML after formats backfills). */
export function buildSrcset(record: UploadedFileRecord): string | null {
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

/** Rebuild an <img> tag around a file record: fresh src/srcset/sizes/dims,
 *  carrying over alt/title/class/id/loading from the old tag (exported for
 *  fix-content-srcsets alongside buildSrcset). */
export function rebuildImgTag(tag: string, record: UploadedFileRecord): string {
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

/**
 * Rewrites every <img> tag in an HTML value through `rebuild`. Duplicate tags
 * are rebuilt once (the callback never runs for a tag already in the map);
 * a null result leaves the tag untouched. Replacements apply via split/join,
 * so every occurrence of a rebuilt tag changes together.
 */
export async function replaceImgTags(
  html: string,
  rebuild: (tag: string) => Promise<string | null>
): Promise<{ html: string; replacements: Map<string, string> }> {
  const replacements = new Map<string, string>();
  for (const match of html.matchAll(/<img\b[^>]*\/?>/gi)) {
    const tag = match[0];
    if (replacements.has(tag)) continue;
    const rebuilt = await rebuild(tag);
    if (rebuilt !== null) replacements.set(tag, rebuilt);
  }

  let out = html;
  for (const [oldTag, newTag] of replacements) {
    out = out.split(oldTag).join(newTag);
  }
  return { html: out, replacements };
}
