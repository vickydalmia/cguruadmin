export const HEADER_SEARCH_SUGGESTIONS: ReadonlyArray<{
  text: string;
  url: string;
}> = [
  { text: "Amazon Coupons", url: "/search/?q=Amazon" },
  { text: "Flipkart Offers", url: "/search/?q=Flipkart" },
  { text: "Myntra Coupons", url: "/search/?q=Myntra" },
  { text: "Today’s Deals", url: "/deal-of-the-day/" },
];

export type PopularSearchKind = "store" | "brand" | "category" | "bank";

export type LegacyPopularSearchLink = {
  url?: string | null;
  storeIds?: readonly number[];
  categoryIds?: readonly number[];
};

export type PopularSearchCatalogs = Record<
  PopularSearchKind,
  ReadonlyMap<string, number>
>;

export type PopularSearchTarget = {
  kind: PopularSearchKind;
  id: number;
};

export function uniquePositiveIds(
  ...groups: ReadonlyArray<readonly number[]>
): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const group of groups) {
    for (const id of group) {
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function routeSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  let path: string;
  try {
    path = new URL(value, "https://path.invalid").pathname;
  } catch {
    return null;
  }
  const parts = path
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (
    parts.length > 1 &&
    ["stores", "brands", "categories", "banks"].includes(parts[0])
  ) {
    parts.shift();
  }
  return parts.length === 1 ? parts[0] : null;
}

/**
 * Preserve an old relation first. URL-only legacy rows are accepted only when
 * their canonical route resolves to exactly one entity type, avoiding an
 * arbitrary choice when two taxonomies share a slug.
 */
export function resolveLegacyPopularSearch(
  link: LegacyPopularSearchLink,
  catalogs: PopularSearchCatalogs,
): PopularSearchTarget | null {
  const storeId = uniquePositiveIds(link.storeIds ?? [])[0];
  if (storeId) return { kind: "store", id: storeId };
  const categoryId = uniquePositiveIds(link.categoryIds ?? [])[0];
  if (categoryId) return { kind: "category", id: categoryId };

  const slug = routeSlug(link.url);
  if (!slug || slug === "deal-of-the-day") return null;
  const matches = (Object.keys(catalogs) as PopularSearchKind[]).flatMap(
    (kind) => {
      const id = catalogs[kind].get(slug);
      return id ? [{ kind, id }] : [];
    },
  );
  return matches.length === 1 ? matches[0] : null;
}
