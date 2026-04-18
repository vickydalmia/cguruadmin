/**
 * Convert a WordPress datetime string to an ISO-8601 UTC string.
 *
 * WordPress stores `post_date_gmt` / `post_modified_gmt` as "YYYY-MM-DD HH:MM:SS"
 * already in UTC. This helper parses that (and any value with a trailing Z or
 * numeric offset) into a canonical ISO string. Values without an offset are
 * assumed to be UTC, so only the `*_gmt` columns should be passed in.
 */
export function normalizeWpDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = value.replace(" ", "T");
  const hasOffset = iso.endsWith("Z") || /[+\-]\d{2}:?\d{2}$/.test(iso);
  const date = new Date(hasOffset ? iso : `${iso}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Convert a WordPress local datetime string to an ISO-8601 UTC string.
 *
 * Non-GMT WordPress columns such as `post_date` are stored in the site/local
 * timezone without an explicit offset. For these fallbacks, parse the value as
 * local time instead of forcing UTC.
 */
export function normalizeWpLocalDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = value.replace(" ", "T");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * WordPress expiration meta may be either a unix timestamp or a date string.
 */
export function parseExpiryDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const ts = parseInt(value, 10);
  if (!isNaN(ts) && ts > 1_000_000_000) {
    return new Date(ts * 1000).toISOString();
  }
  if (value.includes("-")) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
