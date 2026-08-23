// Search QUERY NORMALISATION & RANKING: variant folding, needle
// derivation, relevance scoring and stable ordering. One of the modules
// split out of the search service (see ./search.ts).
import {
  asciiFold,
  entityCountQuery,
  entityRankedQuery,
  isPostgresClient,
  NO_MATCH_TIER,
  offerCountQuery,
  offerRankedQuery,
  RELATION_TIER_SHIFT,
  VARIANT_TIER_SHIFT,
  type OfferKind,
  type SearchNeedles,
  type SqlQuery,
} from "./search-sql";

const GENERIC_SLUG_TERMS = new Set([
  "bank",
  "banks",
  "brand",
  "brands",
  "category",
  "categories",
  "code",
  "codes",
  "coupon",
  "coupons",
  "deal",
  "deals",
  "offer",
  "offers",
  "promo",
  "promos",
  "store",
  "stores",
]);

// Naive substring matching misses plural/singular variants — "Mobiles" must
// find the "Mobile Phones" category. Singular candidates are derived with
// conservative stemmer rules so real words never get mangled into short junk
// needles ("boss" must NOT become "bos", "shoes" must NOT become "sho"):
//   -ies → -y (categories → category)
//   -es  →  ∅ only after ch/sh/x/z (watches → watch, boxes → box)
//   -s   →  ∅ unless the word ends in ss/us/is (mobiles → mobile; boss stays)
// and every derived stem must keep ≥3 characters.
export function queryVariants(query: string): string[] {
  const q = query.trim();
  const variants = new Set([q]);
  const folded = asciiFold(q);

  if (folded.endsWith("ies") && folded.length - 3 >= 3) {
    variants.add(q.slice(0, -3) + "y");
  } else if (/(?:ch|sh|x|z)es$/u.test(folded) && folded.length - 2 >= 3) {
    variants.add(q.slice(0, -2));
  } else if (
    folded.endsWith("s") &&
    !/(?:ss|us|is)$/u.test(folded) &&
    folded.length - 1 >= 3
  ) {
    variants.add(q.slice(0, -1));
  }
  return [...variants];
}

// SQL needles: a shorter variant substring-subsumes a longer one for
// literal containment (rows matching "mobiles" all match "mobile"), so drop any
// variant that contains another — fewer OR clauses, identical row set.
function filterNeedles(variants: string[]): string[] {
  const folded = variants.map(asciiFold);
  return variants.filter((_, index) =>
    folded.every(
      (other, otherIndex) =>
        otherIndex === index || !folded[index].includes(other),
    ),
  );
}

function relevanceForNeedle(candidate: string, needle: string): number {
  if (candidate === needle) return 0;
  if (candidate.startsWith(needle)) return 1;
  if (candidate.includes(" " + needle)) return 2;
  return candidate.includes(needle) ? 3 : 4;
}

// Locale-independent on purpose: host ICU/locale differences must never
// reorder results between instances behind the load balancer.
export function normalizeLabel(value: string): string {
  return asciiFold(value);
}

// PostgreSQL's C collation compares the UTF-8 representation bytewise. Using
// Buffer.compare instead of JS's UTF-16 `<` keeps the fallback's label and
// document-id tails identical for supplementary Unicode code points too.
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// Matches on the query AS TYPED rank in tiers 0-3; matches only via a
// singular/plural variant rank in tiers 4-7 (variant tier + 4), so a variant
// hit can never outrank a literal one; no match at all sinks to NO_MATCH_TIER
// (shared with the SQL scorer, so shifted relation tiers still rank above
// unscored rows in both modes).
export function relevanceForVariants(value: string, variants: string[]): number {
  const candidate = normalizeLabel(value);
  const literal = relevanceForNeedle(candidate, asciiFold(variants[0]));
  if (literal < 4) return literal;

  let best = NO_MATCH_TIER;
  for (const variant of variants.slice(1)) {
    const tier = relevanceForNeedle(candidate, asciiFold(variant));
    if (tier < 4) best = Math.min(best, tier + VARIANT_TIER_SHIFT);
  }
  return best;
}

// One scoreable field of a fallback item: direct fields (name/title, coupon
// code) score at their tier as-is; relation names carry the SQL scorer's
// RELATION_TIER_SHIFT so a relation hit ranks strictly below every
// direct/variant tier.
type ScoreField = { value: string; shift: number };

// Fallback twin of the ranked SQL ORDER BY tuple: best (lowest) shifted tier
// across the item's fields — the JS mirror of LEAST() over per-column CASE
// tiers — then normalized label ASC, then documentId ASC.
export function rank<T extends Record<string, any>>(
  items: T[],
  query: string,
  fields: (item: T) => ScoreField[],
  label: (item: T) => string,
): T[] {
  // Variants are computed once and each item scored once (not per
  // comparison) — the comparator runs O(n log n) times over the fallback
  // matching set.
  const variants = queryVariants(query);
  const scores = new Map<T, number>(
    items.map((item) => [
      item,
      Math.min(
        ...fields(item).map(
          (field) => relevanceForVariants(field.value, variants) + field.shift,
        ),
      ),
    ]),
  );
  const labels = new Map<T, string>(
    items.map((item) => [item, normalizeLabel(label(item))]),
  );
  return [...items].sort((a, b) => {
    const byMatch = scores.get(a)! - scores.get(b)!;
    if (byMatch) return byMatch;
    const byLabel = compareUtf8(labels.get(a)!, labels.get(b)!);
    if (byLabel) return byLabel;
    return compareUtf8(
      String(a?.documentId ?? a?.id ?? ""),
      String(b?.documentId ?? b?.id ?? ""),
    );
  });
}

export function slugNeedle(value: string): string | null {
  const normalized = value.normalize("NFKC");
  if (!/^[\x00-\x7F]*$/u.test(normalized)) return null;
  const needle = asciiFold(normalized)
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!needle || GENERIC_SLUG_TERMS.has(needle)) return null;
  return needle;
}

export function searchNeedles(query: string): SearchNeedles {
  const variants = queryVariants(query);
  const whereNeedles = filterNeedles(variants);
  const slugNeedles = Array.from(
    new Set(whereNeedles.map(slugNeedle).filter(Boolean)),
  ) as string[];
  return { variants, whereNeedles, slugNeedles };
}
