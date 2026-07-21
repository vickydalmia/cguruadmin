// Raw-SQL ranked queries for the public /search service (Postgres only).
// Builders are pure — they return { sql, bindings } and never touch a
// database — so tier logic is unit-testable without a connection; execution
// lives in search.ts, gated on the pg client with the query-engine fallback.
//
// Ranking tiers mirror the JS scorer (relevanceForNeedle/relevanceForVariants
// in search.ts):
//   0-3   literal needle: exact / prefix / word-boundary / substring
//   4-7   derived singular-plural variants (+4, strictly below literals)
//   8-15  relation-name matches (+8, below every direct/variant tier)
//   99    no scored match (row qualified via slug prefix only) — sinks last
// Ties break on the ASCII-folded label under PostgreSQL's bytewise C collation,
// then document_id ASC: a total order shared by the JS fallback. pg_trgm is
// deliberately absent from membership and ordering semantics; its extension
// and indexes affect execution speed only.
//
// Table/column names verified against the Strapi 5 schema conventions used
// by migration/src/phases/07-coupons.ts, 08-deals.ts and 12-offer-backfill.ts
// (snake_case columns, `<owner>_<attribute>_lnk` join tables).

export type SqlQuery = { sql: string; bindings: Array<string | number> };

export type SearchNeedles = {
  /** variants[0] is the query as typed; later entries are derived stems. */
  variants: string[];
  /** Subsumption-filtered needles for WHERE (same row set, fewer clauses). */
  whereNeedles: string[];
  /** Slugified prefix needles (generic route terms already dropped). */
  slugNeedles: string[];
};

export type EntityTable = "stores" | "brands" | "categories" | "banks";
export type OfferKind = "coupon" | "deal";
export type PageWindow = { limit: number; offset: number };

// NO_MATCH_TIER and RELATION_TIER_SHIFT are exported so the fallback scorer
// in search.ts shares the exact tier arithmetic instead of mirroring copies.
export const NO_MATCH_TIER = 99;
export const VARIANT_TIER_SHIFT = 4;
export const RELATION_TIER_SHIFT = 8;
const ESC = "ESCAPE '\\'";
const ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";

// Search case folding is deliberately narrower than Unicode lowercasing.
// PostgreSQL lower() is locale-dependent, while JS toLowerCase() follows
// Unicode rules; those can disagree (notably for dotted I). Mapping ASCII
// A-Z only gives both execution modes one deterministic semantic operation.
export function asciiFold(value: string): string {
  return value.replace(/[A-Z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );
}

function asciiFoldSql(column: string): string {
  return `translate(${column}, '${ASCII_UPPER}', '${ASCII_LOWER}')`;
}

export function isPostgresClient(client: unknown): boolean {
  return ["pg", "postgres", "postgresql"].includes(
    String(client ?? "").toLowerCase(),
  );
}

// LIKE treats % _ \ as metacharacters: user input must only ever match
// literally. Patterns are always bound as parameters, never inlined, so
// quotes and other SQL metacharacters never reach the SQL text.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function containsPattern(needle: string): string {
  return "%" + escapeLike(asciiFold(needle)) + "%";
}

function prefixPattern(needle: string): string {
  return escapeLike(asciiFold(needle)) + "%";
}

function tierCase(
  column: string,
  needle: string,
  base: number,
  bindings: Array<string | number>,
): string {
  const folded = asciiFold(needle);
  const escaped = escapeLike(folded);
  bindings.push(folded, escaped + "%", "% " + escaped + "%", "%" + escaped + "%");
  return (
    `CASE WHEN ${asciiFoldSql(column)} = ? THEN ${base}` +
    ` WHEN ${asciiFoldSql(column)} LIKE ? ${ESC} THEN ${base + 1}` +
    ` WHEN ${asciiFoldSql(column)} LIKE ? ${ESC} THEN ${base + 2}` +
    ` WHEN ${asciiFoldSql(column)} LIKE ? ${ESC} THEN ${base + 3}` +
    ` ELSE ${NO_MATCH_TIER} END`
  );
}

// Best (lowest) tier across all variants of one column, literal variant
// first at base 0, derived variants shifted +4 — LEAST() is the SQL twin of
// relevanceForVariants' Math.min loop.
function variantTier(
  column: string,
  variants: string[],
  bindings: Array<string | number>,
): string {
  const cases = variants.map((needle, index) =>
    tierCase(column, needle, index === 0 ? 0 : VARIANT_TIER_SHIFT, bindings),
  );
  return cases.length > 1 ? `LEAST(${cases.join(", ")})` : cases[0];
}

function matchClauses(
  columns: { contains: string[]; prefix: string[] },
  needles: SearchNeedles,
  bindings: Array<string | number>,
): string[] {
  const clauses: string[] = [];
  for (const column of columns.contains) {
    for (const needle of needles.whereNeedles) {
      const pattern = containsPattern(needle);
      bindings.push(pattern);
      clauses.push(`${asciiFoldSql(column)} LIKE ? ${ESC}`);
    }
  }
  for (const column of columns.prefix) {
    for (const slug of needles.slugNeedles) {
      const pattern = prefixPattern(slug);
      bindings.push(pattern);
      clauses.push(`${asciiFoldSql(column)} LIKE ? ${ESC}`);
    }
  }
  return clauses;
}

function entityWhere(
  needles: SearchNeedles,
  bindings: Array<string | number>,
): string {
  const clauses = matchClauses(
    { contains: ["name"], prefix: ["slug"] },
    needles,
    bindings,
  );
  return `published_at IS NOT NULL AND (${clauses.join(" OR ")})`;
}

export function entityRankedQuery(
  table: EntityTable,
  needles: SearchNeedles,
  page: PageWindow,
): SqlQuery {
  const bindings: Array<string | number> = [];
  const where = entityWhere(needles, bindings);
  const tier = variantTier("name", needles.variants, bindings);
  bindings.push(page.limit, page.offset);
  return {
    sql:
      `SELECT id, document_id FROM ${table} WHERE ${where} ` +
      `ORDER BY ${tier} ASC, ` +
      `${asciiFoldSql("name")} COLLATE "C" ASC, ` +
      `document_id COLLATE "C" ASC ` +
      `LIMIT ? OFFSET ?`,
    bindings,
  };
}

export function entityCountQuery(
  table: EntityTable,
  needles: SearchNeedles,
): SqlQuery {
  const bindings: Array<string | number> = [];
  const where = entityWhere(needles, bindings);
  return { sql: `SELECT count(*) AS total FROM ${table} WHERE ${where}`, bindings };
}

type OfferRelation = {
  link: string;
  ownerColumn: string;
  table: string;
  targetColumn: string;
};

const OFFER_TABLE: Record<OfferKind, string> = {
  coupon: "coupons",
  deal: "deals",
};

const OFFER_RELATIONS: Record<OfferKind, OfferRelation[]> = {
  coupon: [
    { link: "coupons_stores_lnk", ownerColumn: "coupon_id", table: "stores", targetColumn: "store_id" },
    { link: "coupons_brands_lnk", ownerColumn: "coupon_id", table: "brands", targetColumn: "brand_id" },
    { link: "coupons_categories_lnk", ownerColumn: "coupon_id", table: "categories", targetColumn: "category_id" },
    { link: "coupons_banks_lnk", ownerColumn: "coupon_id", table: "banks", targetColumn: "bank_id" },
  ],
  deal: [
    { link: "deals_stores_lnk", ownerColumn: "deal_id", table: "stores", targetColumn: "store_id" },
    { link: "deals_brands_lnk", ownerColumn: "deal_id", table: "brands", targetColumn: "brand_id" },
    { link: "deals_categories_lnk", ownerColumn: "deal_id", table: "categories", targetColumn: "category_id" },
    { link: "deals_banks_lnk", ownerColumn: "deal_id", table: "banks", targetColumn: "bank_id" },
    // primaryStore is manyToOne but Strapi 5 still stores it in a link table.
    { link: "deals_primary_store_lnk", ownerColumn: "deal_id", table: "stores", targetColumn: "store_id" },
  ],
};

const OFFER_DIRECT_COLUMNS: Record<OfferKind, string[]> = {
  coupon: ["o.title", "o.code"],
  deal: ["o.title"],
};

// Membership arms for `o.id IN (...)`. Each arm is independently
// index-driven: the direct arm scans the offer's own trigram indexes; each
// relation arm finds the few matching relation rows by trigram index first,
// then fans out to offer ids through the link table's target-column index.
// UNION ALL keeps duplicates — IN() is a semijoin, so they are harmless and
// the dedup sort a plain UNION would add is wasted work.
function directMembershipArm(
  kind: OfferKind,
  needles: SearchNeedles,
  bindings: Array<string | number>,
): string {
  const clauses = matchClauses(
    {
      contains: OFFER_DIRECT_COLUMNS[kind].map((column) =>
        column.replace(/^o\./u, "d."),
      ),
      prefix: [],
    },
    needles,
    bindings,
  );
  return `SELECT d.id FROM ${OFFER_TABLE[kind]} d WHERE ${clauses.join(" OR ")}`;
}

function relationMembershipArm(
  relation: OfferRelation,
  needles: SearchNeedles,
  bindings: Array<string | number>,
): string {
  const clauses = matchClauses(
    { contains: ["r.name"], prefix: ["r.slug"] },
    needles,
    bindings,
  );
  return (
    `SELECT l.${relation.ownerColumn} FROM ${relation.link} l ` +
    `JOIN ${relation.table} r ON r.id = l.${relation.targetColumn} ` +
    `WHERE ${clauses.join(" OR ")}`
  );
}

function relationTier(
  relation: OfferRelation,
  variants: string[],
  bindings: Array<string | number>,
): string {
  const tier = variantTier("r.name", variants, bindings);
  return (
    `(COALESCE((SELECT MIN(${tier}) FROM ${relation.link} l ` +
    `JOIN ${relation.table} r ON r.id = l.${relation.targetColumn} ` +
    `WHERE l.${relation.ownerColumn} = o.id), ${NO_MATCH_TIER}) + ${RELATION_TIER_SHIFT})`
  );
}

// Mirrors publishedOnlyFilters (content-status.ts) plus the product-deal
// sale_price rule from productDealFilters; published_at is defensive (all
// offer types have draftAndPublish disabled, so it is always set).
//
// Membership is `o.id IN (direct arm UNION ALL relation arms)` rather than
// `direct LIKE OR EXISTS(...) OR ...`: the OR-of-EXISTS shape cannot be
// served by any single index, so the planner seq-scans every offer row —
// and its wildly inflated cost estimate (it assumes most rows match) also
// pushes the query over the JIT compilation thresholds, which dominated
// production latency on small instances (observed: 17s of a 19s count was
// LLVM JIT). The UNION ALL arms are each index-driven, keep the identical
// row set, and carry an honest cost estimate.
function offerWhere(
  kind: OfferKind,
  needles: SearchNeedles,
  nowIso: string,
  bindings: Array<string | number>,
): string {
  bindings.push(nowIso);
  const visibility =
    "o.published_at IS NOT NULL AND o.content_status = 'published' " +
    "AND (o.expires_at IS NULL OR o.expires_at > ?)" +
    (kind === "deal" ? " AND o.sale_price IS NOT NULL AND o.sale_price > 0" : "");
  const arms = [
    directMembershipArm(kind, needles, bindings),
    ...OFFER_RELATIONS[kind].map((relation) =>
      relationMembershipArm(relation, needles, bindings),
    ),
  ];
  return `${visibility} AND o.id IN (${arms.join(" UNION ALL ")})`;
}

export function offerRankedQuery(
  kind: OfferKind,
  needles: SearchNeedles,
  page: PageWindow,
  nowIso: string,
): SqlQuery {
  const bindings: Array<string | number> = [];
  const where = offerWhere(kind, needles, nowIso, bindings);
  const tiers = [
    ...OFFER_DIRECT_COLUMNS[kind].map((column) =>
      variantTier(column, needles.variants, bindings),
    ),
    ...OFFER_RELATIONS[kind].map((relation) =>
      relationTier(relation, needles.variants, bindings),
    ),
  ];
  bindings.push(page.limit, page.offset);
  return {
    sql:
      `SELECT o.id, o.document_id FROM ${OFFER_TABLE[kind]} o WHERE ${where} ` +
      `ORDER BY LEAST(${tiers.join(", ")}) ASC, ` +
      `${asciiFoldSql("o.title")} COLLATE "C" ASC, ` +
      `o.document_id COLLATE "C" ASC ` +
      `LIMIT ? OFFSET ?`,
    bindings,
  };
}

export function offerCountQuery(
  kind: OfferKind,
  needles: SearchNeedles,
  nowIso: string,
): SqlQuery {
  const bindings: Array<string | number> = [];
  const where = offerWhere(kind, needles, nowIso, bindings);
  return {
    sql: `SELECT count(*) AS total FROM ${OFFER_TABLE[kind]} o WHERE ${where}`,
    bindings,
  };
}
