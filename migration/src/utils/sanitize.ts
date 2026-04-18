/**
 * Sanitisation helpers for migration data.
 *
 * - `clean()`    – trim whitespace; collapse to null when empty.
 * - `cleanSlug()` – trim, lowercase, strip anything that isn't [a-z0-9-].
 * - `cleanCode()` – trim whitespace from coupon/unique codes.
 */

/** Trim whitespace from a string value. Returns null if the result is empty. */
export function clean(val: string | null | undefined): string | null {
  if (val == null) return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Sanitise a URL slug: trim, lowercase, replace whitespace/underscores with
 * hyphens, strip non-slug characters, collapse consecutive hyphens, and
 * strip leading/trailing hyphens.
 */
export function cleanSlug(val: string | null | undefined): string {
  if (!val) return "";
  return val
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")        // spaces/underscores → hyphen
    .replace(/[^a-z0-9-]/g, "")     // strip special chars
    .replace(/-{2,}/g, "-")         // collapse multiple hyphens
    .replace(/^-|-$/g, "");         // strip leading/trailing hyphens
}

/** Trim whitespace from a coupon code. Returns null if empty. */
export function cleanCode(val: string | null | undefined): string | null {
  if (val == null) return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}
