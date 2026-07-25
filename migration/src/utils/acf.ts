import { unserialize } from "php-serialize";

/**
 * Parses an ACF term-reference meta value into a WP term ID. Depending on the
 * ACF field config the value is either a plain ID ("123") or a PHP-serialized
 * array (`a:1:{i:0;s:3:"123";}`).
 *
 * Shared by phase 08 (which links `deal_store` while creating the deal) and
 * phase 12 (the additive safety net). Phase 08 previously used a bare
 * `parseInt`, which returns NaN for every serialized value and silently
 * dropped those stores.
 */
export function parseAcfTermId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  // PHP-serialized value (array, string, or int)
  if (/^[asiO]:/.test(trimmed)) {
    try {
      const parsed = unserialize(trimmed);
      const first = Array.isArray(parsed)
        ? parsed[0]
        : parsed !== null && typeof parsed === "object"
          ? Object.values(parsed)[0]
          : parsed;
      const id = parseInt(String(first), 10);
      return isNaN(id) ? null : id;
    } catch {
      return null;
    }
  }

  const fallback = parseInt(trimmed, 10);
  return isNaN(fallback) ? null : fallback;
}

/**
 * Truthiness for an ACF true/false meta value.
 *
 * The live WordPress data stores `popular_coupon` strictly as "0" or "1", so a
 * bare `=== "1"` is correct TODAY. This is deliberately more tolerant because
 * the check drives content (`badge: "Recommended"`) and an ACF field retyped to
 * a checkbox or select would start emitting "yes"/"true" — silently badging
 * nothing, with no error to notice. Everything else, including "0" and "",
 * stays false, so no offer is badged by accident.
 */
export function isAcfTrue(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
