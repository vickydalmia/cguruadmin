/**
 * WordPress source-field aliases.
 *
 * Every CouponzGuru country site stores the same logical fields, but the
 * Singapore site kept its legacy CMB2 field names inside ACF (`_cmb_coupon_code`
 * instead of `code`, `store_image` instead of `store_cat_image`, ...). Each
 * logical field therefore has an ordered alias list, canonical key first, and
 * every reader resolves the FIRST non-empty value in that order — the same
 * precedence pattern `wp-offer-expiry.ts` applies to the expiry plugins.
 *
 * The aliases are global rather than profile-gated on purpose: the India, USA
 * and UAE sources hold zero rows under any alias key (verified against the full
 * dumps on 2026-09-06), so the resolved value there is byte-for-byte what the
 * canonical key alone produced. If a source ever carried both keys, the
 * canonical value wins.
 */

export const OFFER_META_ALIASES = {
  code: ["code", "_cmb_coupon_code"],
  link: ["link", "_cmb_affiliate_link"],
  image: ["image", "_cmb_coupon_image"],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export const TERM_META_ALIASES = {
  image: ["store_cat_image", "store_image"],
  imageAlt: ["store_image_alt"],
} as const satisfies Record<string, readonly [string, ...string[]]>;

type AliasGroups = Record<string, readonly [string, ...string[]]>;

/**
 * `rewriteWpTableNames` (utils/wp-table.ts) rewrites every `wp_*` token in a
 * query to the configured table prefix, so a meta key that started with `wp_`
 * would be mangled inside a `meta_key IN (...)` list. Keys are trusted
 * constants; this guard exists so a future alias cannot silently break SQL.
 */
function assertSqlSafeMetaKey(key: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(key) || /^wp_/iu.test(key)) {
    throw new Error(`Unsupported WordPress meta key for SQL: ${key}`);
  }
  return key;
}

function dedupe(keys: readonly string[]): string[] {
  return [...new Set(keys.map(assertSqlSafeMetaKey))];
}

function allKeys(groups: AliasGroups, passthrough: readonly string[]): string[] {
  return dedupe([
    ...Object.values(groups).flat(),
    ...passthrough,
  ]);
}

/** Render keys as a quoted SQL `IN (...)` body: `'code', '_cmb_coupon_code'`. */
export function sqlMetaKeyList(keys: readonly string[]): string {
  return dedupe(keys)
    .map((key) => `'${key}'`)
    .join(", ");
}

/** Canonical + alias + passthrough offer post-meta keys for a `meta_key IN (...)` list. */
export function offerMetaKeys(passthrough: readonly string[] = []): string[] {
  return allKeys(OFFER_META_ALIASES, passthrough);
}

/** Canonical + alias + passthrough term-meta keys for a `tm.meta_key IN (...)` list. */
export function termMetaKeys(passthrough: readonly string[] = []): string[] {
  return allKeys(TERM_META_ALIASES, passthrough);
}

/**
 * Fold alias keys into their canonical key. For each logical field the first
 * non-blank value in alias order is kept under the canonical key; alias keys
 * are removed so no downstream code can read a stale variant by accident.
 * Keys outside the alias groups pass through untouched.
 */
export function normaliseAliasedMeta<T extends Record<string, string>>(
  meta: T,
  groups: AliasGroups,
): T {
  const result: Record<string, string> = { ...meta };
  for (const aliases of Object.values(groups)) {
    const [canonical, ...rest] = aliases;
    let resolved: string | undefined;
    for (const key of aliases) {
      const value = result[key];
      if (typeof value === "string" && value.trim() !== "") {
        resolved = value;
        break;
      }
    }
    for (const key of rest) delete result[key];
    // Nothing resolved leaves the canonical entry exactly as the source had it
    // (possibly blank), so existing sites see the same value as before.
    if (resolved !== undefined) result[canonical] = resolved;
  }
  return result as T;
}

/** Offer (Coupon/Deal) post-meta normalisation: `meta.code` / `meta.link` / `meta.image`. */
export function normaliseOfferMeta<T extends Record<string, string>>(meta: T): T {
  return normaliseAliasedMeta(meta, OFFER_META_ALIASES);
}

/**
 * Pick the first non-blank value for one alias group from `(meta_key,
 * meta_value)` rows, honouring alias order rather than row order. Used where a
 * query selects a single logical field across several posts.
 */
export function firstAliasValue(
  aliases: readonly string[],
  rows: ReadonlyArray<{ meta_key: string; meta_value: string | null }>,
): string | undefined {
  for (const key of aliases) {
    const row = rows.find(
      (candidate) =>
        candidate.meta_key === key &&
        typeof candidate.meta_value === "string" &&
        candidate.meta_value.trim() !== "",
    );
    if (row) return row.meta_value as string;
  }
  return undefined;
}

/**
 * SQL aggregate that resolves one term-meta field across its aliases inside a
 * `GROUP BY term` query:
 *
 *   COALESCE(
 *     MAX(CASE WHEN tm.meta_key = 'store_cat_image' THEN NULLIF(tm.meta_value, '') END),
 *     MAX(CASE WHEN tm.meta_key = 'store_image' THEN NULLIF(tm.meta_value, '') END)
 *   )
 *
 * `NULLIF` makes a blank canonical value fall through to the alias, matching
 * `normaliseAliasedMeta`.
 */
export function termMetaCoalesceSql(
  aliases: readonly string[],
  tableAlias = "tm",
): string {
  const branches = dedupe(aliases).map(
    (key) =>
      `MAX(CASE WHEN ${tableAlias}.meta_key = '${key}' THEN NULLIF(${tableAlias}.meta_value, '') END)`,
  );
  return branches.length === 1 ? branches[0] : `COALESCE(${branches.join(", ")})`;
}
