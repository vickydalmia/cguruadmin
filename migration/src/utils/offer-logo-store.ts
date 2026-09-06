import { wpQuery } from "../db/wp-client.js";
import { TERM_META_ALIASES, sqlMetaKeyList } from "./wp-source-fields.js";

export type StoreLogoIndex = ReadonlyMap<string, readonly number[]>;

/** Match media by its WordPress upload path, ignoring host, protocol and query. */
export function normalizeWpMediaPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const path = new URL(value.trim(), "https://path.invalid").pathname;
    return decodeURIComponent(path).replace(/\/{2,}/gu, "/").toLowerCase();
  } catch {
    return null;
  }
}

export async function loadWpStoreLogoIndex(): Promise<StoreLogoIndex> {
  const rows = await wpQuery<{ term_id: number; image_url: string | null }>(`
    SELECT logo.term_id,
           COALESCE(NULLIF(attachment.guid, ''), NULLIF(logo.meta_value, '')) AS image_url
    FROM wp_termmeta logo
    JOIN wp_termmeta kind
      ON kind.term_id = logo.term_id
     AND kind.meta_key = 'choose_type'
     AND kind.meta_value = 'Store'
    LEFT JOIN wp_posts attachment
      ON attachment.ID = CAST(logo.meta_value AS UNSIGNED)
     AND attachment.post_type = 'attachment'
    WHERE logo.meta_key IN (${sqlMetaKeyList(TERM_META_ALIASES.image)})
    ORDER BY logo.term_id
  `);

  const mutable = new Map<string, number[]>();
  for (const row of rows) {
    const path = normalizeWpMediaPath(row.image_url);
    if (!path) continue;
    const ids = mutable.get(path) ?? [];
    if (!ids.includes(row.term_id)) ids.push(row.term_id);
    mutable.set(path, ids);
  }
  return mutable;
}

/**
 * Return all Stores using the Coupon's old image. If duplicate Store logos
 * exist, a Store already related to the Coupon wins; the remaining stable
 * order lets the relation writer skip excluded/unmapped Stores safely.
 */
export function couponLogoStoreCandidates(
  imageUrl: unknown,
  relatedTermIds: readonly number[],
  index: StoreLogoIndex,
): number[] {
  const path = normalizeWpMediaPath(imageUrl);
  const matches = path ? [...(index.get(path) ?? [])] : [];
  if (matches.length < 2) return matches;

  const related = new Set(relatedTermIds);
  return [
    ...matches.filter((termId) => related.has(termId)),
    ...matches.filter((termId) => !related.has(termId)),
  ];
}
