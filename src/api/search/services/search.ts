import { AsyncLocalStorage } from "node:async_hooks";

import type { Core } from "@strapi/strapi";
import { normaliseImageBackgroundColour } from "../../../constants/image-background";
import { publishedOnlyFilters } from "../../../utils/content-status";
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

// 3 is a hard floor for performance, not taste: pg_trgm needs a full
// trigram, so an unanchored LIKE '%xx%' with a 2-char needle can never use
// the GIN indexes and every membership arm seq-scans (observed ~2s previews).
const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 80;
const PREVIEW_ENTITY_LIMIT = 7;
const PREVIEW_OFFER_LIMIT = 3;
// Preview-only null-backfill margin: a ranked row can hydrate but map to
// null (missing name/slug) or get dropped by the hydrate visibility
// re-check, which would shrink the preview list below its display limit.
// Preview windows over-fetch this many extra ranked ids so dropped rows
// backfill from the next candidates. Paged group requests never over-fetch —
// their LIMIT/OFFSET must stay exact or page boundaries would shift.
const PREVIEW_BACKFILL = 2;
const FALLBACK_READ_BATCH_SIZE = 500;
const MAX_PAGE = 20;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const EXPECTED_SEARCH_INDEX_DEFINITIONS = [
  { name: "stores_name_search_trgm_idx", table: "stores", column: "name" },
  { name: "brands_name_search_trgm_idx", table: "brands", column: "name" },
  { name: "categories_name_search_trgm_idx", table: "categories", column: "name" },
  { name: "banks_name_search_trgm_idx", table: "banks", column: "name" },
  { name: "coupons_title_search_trgm_idx", table: "coupons", column: "title" },
  { name: "deals_title_search_trgm_idx", table: "deals", column: "title" },
  { name: "stores_slug_search_trgm_idx", table: "stores", column: "slug" },
  { name: "brands_slug_search_trgm_idx", table: "brands", column: "slug" },
  { name: "categories_slug_search_trgm_idx", table: "categories", column: "slug" },
  { name: "banks_slug_search_trgm_idx", table: "banks", column: "slug" },
  { name: "coupons_code_search_trgm_idx", table: "coupons", column: "code" },
] as const;
export const EXPECTED_SEARCH_INDEXES = EXPECTED_SEARCH_INDEX_DEFINITIONS.map(
  ({ name }) => name,
);
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

const GROUPS = [
  "stores",
  "brands",
  "categories",
  "banks",
  "coupons",
  "deals",
] as const;
type SearchGroup = (typeof GROUPS)[number];
type SearchRequest = {
  query: string;
  mode: "preview" | "group";
  group?: SearchGroup;
  page: number;
  pageSize: number;
};
type EntityConfig = {
  key: "stores" | "brands" | "categories" | "banks";
  kind: "store" | "brand" | "category" | "bank";
  uid: string;
  mediaField: "logo" | "icon";
};

const ENTITIES: readonly EntityConfig[] = [
  { key: "stores", kind: "store", uid: "api::store.store", mediaField: "logo" },
  { key: "brands", kind: "brand", uid: "api::brand.brand", mediaField: "logo" },
  {
    key: "categories",
    kind: "category",
    uid: "api::category.category",
    mediaField: "icon",
  },
  { key: "banks", kind: "bank", uid: "api::bank.bank", mediaField: "logo" },
];

const relationRef = (mediaField: "logo" | "icon" = "logo") => ({
  fields:
    mediaField === "logo"
      ? ["name", "slug", "logoAlt"]
      : ["name", "slug", "iconAlt"],
  populate: { [mediaField]: true },
});
const relations = Object.fromEntries(
  ENTITIES.map((config) => [config.key, relationRef(config.mediaField)]),
) as Record<EntityConfig["key"], ReturnType<typeof relationRef>>;
const couponPopulate = { ...relations, image: true };
const dealPopulate = {
  ...relations,
  dealImage: true,
};

// Field/populate sets are shared between the query-engine finders and the
// ranked-ID hydration step so both paths emit byte-identical responses.
const entityFields = (config: EntityConfig) => [
  "name",
  "slug",
  config.mediaField === "logo" ? "logoAlt" : "iconAlt",
];

function mediaAlt(
  document: any,
  mediaField: "logo" | "icon",
  fallback: string | null,
): string | null {
  return (
    cleanText(
      mediaField === "icon" ? document?.iconAlt : document?.logoAlt,
      300,
    ) ?? fallback
  );
}
const COUPON_FIELDS = ["title", "code", "couponType", "affiliateLink"];
const DEAL_FIELDS = [
  "title",
  "affiliateLink",
  "salePrice",
  "mrp",
  "discount",
  "expiresAt",
];

function oneString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function positiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const raw = oneString(value);
  if (!raw || !/^\d+$/u.test(raw)) return fallback;
  return Math.max(1, Math.min(Number(raw), max));
}

function parseRequest(raw: Record<string, unknown>) {
  const allowed = new Set(["query", "mode", "group", "page", "pageSize"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    return { ok: false as const, message: "Unsupported search parameter" };
  }

  const rawQuery = oneString(raw.query);
  if (rawQuery === null) {
    return { ok: false as const, message: "Search query must be a string" };
  }

  const query = normalizeQuery(rawQuery);
  const length = Array.from(query).length;
  if (length < MIN_QUERY_LENGTH || length > MAX_QUERY_LENGTH) {
    return {
      ok: false as const,
      message: `Search query must be between ${MIN_QUERY_LENGTH} and ${MAX_QUERY_LENGTH} characters`,
    };
  }

  const requestedMode = oneString(raw.mode);
  if (
    requestedMode !== null &&
    requestedMode !== "preview" &&
    requestedMode !== "group"
  ) {
    return { ok: false as const, message: "Invalid search mode" };
  }

  const rawGroup = oneString(raw.group);
  const group =
    rawGroup && GROUPS.includes(rawGroup as SearchGroup)
      ? (rawGroup as SearchGroup)
      : undefined;
  const mode: "preview" | "group" = group
    ? "group"
    : requestedMode === "group"
      ? "group"
      : "preview";
  if ((mode === "group" && !group) || (rawGroup && !group)) {
    return { ok: false as const, message: "A valid search group is required" };
  }

  return {
    ok: true as const,
    value: {
      query,
      mode,
      group,
      page: positiveInteger(raw.page, 1, MAX_PAGE),
      pageSize: positiveInteger(raw.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    } satisfies SearchRequest,
  };
}

function cleanText(value: unknown, maxLength = 300): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized ? normalized.slice(0, maxLength) : null;
}

function safeHref(value: unknown): string | null {
  const href = cleanText(value, 2048);
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function safeEntityHref(slug: unknown): string | null {
  const value = cleanText(slug, 180);
  if (!value) return null;

  const path = value.replace(/^\/+|\/+$/gu, "");
  const segment = "[a-z0-9]+(?:-[a-z0-9]+)*";
  if (!new RegExp(`^${segment}(?:/${segment})*$`, "iu").test(path)) {
    return null;
  }
  return "/" + path + "/";
}

function mapMedia(media: any, fallbackAlt: string) {
  const src = safeHref(media?.url);
  if (!src) return null;

  // A plain img srcset cannot advertise mixed AVIF and WebP candidates:
  // srcset keeps the universally usable WebP/fallback variants, while the
  // `_avif` twin formats feed the separate avifSrcset (consumed by a
  // <source type="image/avif">, additive — null until twins exist).
  const byWidth = new Map<number, string>();
  const avifByWidth = new Map<number, string>();
  for (const [formatName, format] of Object.entries(
    media?.formats ?? {},
  ) as Array<[string, any]>) {
    const url = safeHref(format?.url);
    const width = Number(format?.width);
    // Integer check matches cguru-ui's isRenderableCandidate so both ladders
    // agree on which candidates count toward the coverage rule.
    if (!url || !Number.isInteger(width) || width <= 0) continue;
    (formatName.endsWith("_avif") ? avifByWidth : byWidth).set(width, url);
  }

  const toSrcset = (candidates: Map<number, string>) =>
    Array.from(candidates.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([width, url]) => url + " " + width + "w")
      .join(", ");

  const srcset = toSrcset(byWidth);

  // The avif <source> shadows the ENTIRE fallback srcset for avif-capable
  // browsers, so a twin ladder whose top rung was dropped by the encoder's
  // size guard would commit them to upscaling its widest candidate into
  // large slots. Same coverage rule as cguru-ui's avifLadderCoversFallback
  // (separate repo — cannot be imported): the avif ladder qualifies only
  // when its max width reaches the fallback ladder's max width; an empty
  // fallback ladder is covered vacuously (twins-only media keeps its avif).
  const maxWidth = (candidates: Map<number, string>) =>
    Math.max(0, ...candidates.keys());
  const avifSrcset =
    avifByWidth.size > 0 && maxWidth(avifByWidth) >= maxWidth(byWidth)
      ? toSrcset(avifByWidth)
      : "";

  return {
    src,
    backgroundColour: normaliseImageBackgroundColour(media?.backgroundColour),
    srcset: srcset || null,
    avifSrcset: avifSrcset || null,
    width: Number(media?.width) > 0 ? Number(media.width) : null,
    height: Number(media?.height) > 0 ? Number(media.height) : null,
    alt: cleanText(media?.alternativeText, 160) ?? fallbackAlt,
  };
}

function relatedEntities(document: any): any[] {
  return [
    ...(Array.isArray(document?.stores) ? document.stores : []),
    ...(Array.isArray(document?.brands) ? document.brands : []),
    ...(Array.isArray(document?.categories) ? document.categories : []),
    ...(Array.isArray(document?.banks) ? document.banks : []),
  ];
}

// Deals no longer carry a `primaryStore`, so both offer kinds resolve their
// owner the same way: the first related taxonomy entity.
function offerOwner(document: any, _source: "coupon" | "deal") {
  return relatedEntities(document)[0] ?? null;
}

// Naive substring matching misses plural/singular variants — "Mobiles" must
// find the "Mobile Phones" category. Singular candidates are derived with
// conservative stemmer rules so real words never get mangled into short junk
// needles ("boss" must NOT become "bos", "shoes" must NOT become "sho"):
//   -ies → -y (categories → category)
//   -es  →  ∅ only after ch/sh/x/z (watches → watch, boxes → box)
//   -s   →  ∅ unless the word ends in ss/us/is (mobiles → mobile; boss stays)
// and every derived stem must keep ≥3 characters.
function queryVariants(query: string): string[] {
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
function normalizeLabel(value: string): string {
  return asciiFold(value);
}

// PostgreSQL's C collation compares the UTF-8 representation bytewise. Using
// Buffer.compare instead of JS's UTF-16 `<` keeps the fallback's label and
// document-id tails identical for supplementary Unicode code points too.
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// Matches on the query AS TYPED rank in tiers 0-3; matches only via a
// singular/plural variant rank in tiers 4-7 (variant tier + 4), so a variant
// hit can never outrank a literal one; no match at all sinks to NO_MATCH_TIER
// (shared with the SQL scorer, so shifted relation tiers still rank above
// unscored rows in both modes).
function relevanceForVariants(value: string, variants: string[]): number {
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
function rank<T extends Record<string, any>>(
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

function mapEntity(document: any, config: EntityConfig) {
  const name = cleanText(document?.name, 160);
  const link = safeEntityHref(document?.slug);
  if (!name || !link) return null;

  return {
    id: String(
      document?.documentId ?? document?.id ?? config.kind + ":" + document.slug,
    ),
    name,
    link,
    type: config.kind,
    subtitle: null,
    storeName: config.kind === "store" ? name : null,
    media: mapMedia(
      document?.[config.mediaField],
      mediaAlt(document, config.mediaField, name),
    ),
    price: null,
    originalPrice: null,
    discount: null,
  };
}

function mapOffer(document: any, type: "coupon" | "deal") {
  const name = cleanText(document?.title, 300);
  if (!name) return null;

  const owner = offerOwner(document, type);
  const ownerName = cleanText(owner?.name, 160);
  const fallbackLink = safeEntityHref(owner?.slug) ?? "/stores/";
  const sourceMedia = type === "deal" ? document?.dealImage : document?.image;
  const ownerMedia = owner?.logo ?? owner?.icon ?? null;
  const ownerMediaField = owner?.icon ? "icon" : "logo";
  const ownerAlt = mediaAlt(owner, ownerMediaField, ownerName);

  return {
    id: type + ":" + String(document?.documentId ?? document?.id ?? name),
    name,
    link: safeHref(document?.affiliateLink) ?? fallbackLink,
    type,
    subtitle: ownerName,
    storeName: ownerName,
    // Product-deal cards must never disguise a store logo as product media.
    // The deal schema owns dealImage; an incomplete record stays image-less so
    // the UI can use its accessible text fallback instead of showing the wrong
    // visual. Coupon cards continue to prefer the owning store logo.
    media: mapMedia(
      type === "coupon" ? (ownerMedia ?? sourceMedia) : sourceMedia,
      type === "coupon" ? (ownerAlt ?? ownerName ?? name) : name,
    ),
    price:
      type === "deal" && document?.salePrice != null
        ? String(document.salePrice)
        : null,
    originalPrice:
      type === "deal" && document?.mrp != null ? String(document.mrp) : null,
    discount: type === "deal" ? cleanText(document?.discount, 80) : null,
    expiresAt:
      type === "deal" ? cleanText(document?.expiresAt, 80) : null,
    owner:
      type === "deal" && ownerName
        ? {
            name: ownerName,
            logo: mapMedia(ownerMedia, ownerAlt),
          }
        : null,
  };
}

function toPublicOffer(hit: any) {
  return hit ?? null;
}

function slugNeedle(value: string): string | null {
  const normalized = value.normalize("NFKC");
  if (!/^[\x00-\x7F]*$/u.test(normalized)) return null;
  const needle = asciiFold(normalized)
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!needle || GENERIC_SLUG_TERMS.has(needle)) return null;
  return needle;
}

function searchNeedles(query: string): SearchNeedles {
  const variants = queryVariants(query);
  const whereNeedles = filterNeedles(variants);
  const slugNeedles = Array.from(
    new Set(whereNeedles.map(slugNeedle).filter(Boolean)),
  ) as string[];
  return { variants, whereNeedles, slugNeedles };
}

type FallbackRequestCache = Map<string, Promise<any[]>>;

function literalContains(value: unknown, needles: string[]): boolean {
  if (typeof value !== "string") return false;
  const candidate = normalizeLabel(value);
  return needles.some((needle) => candidate.includes(normalizeLabel(needle)));
}

function literalSlugPrefix(value: unknown, needles: string[]): boolean {
  if (typeof value !== "string") return false;
  const candidate = normalizeLabel(value);
  return needles.some((needle) => candidate.startsWith(needle));
}

function entityMatches(document: any, needles: SearchNeedles): boolean {
  return (
    literalContains(document?.name, needles.whereNeedles) ||
    literalSlugPrefix(document?.slug, needles.slugNeedles)
  );
}

function offerMatches(
  document: any,
  kind: OfferKind,
  needles: SearchNeedles,
): boolean {
  if (literalContains(document?.title, needles.whereNeedles)) return true;
  if (
    kind === "coupon" &&
    literalContains(document?.code, needles.whereNeedles)
  ) {
    return true;
  }
  return relatedEntities(document).some(
    (relation) =>
      literalContains(relation?.name, needles.whereNeedles) ||
      literalSlugPrefix(relation?.slug, needles.slugNeedles),
  );
}

// Non-Postgres is a correctness fallback, not a candidate-window heuristic.
// Read every visible row in deterministic 500-row batches, then perform
// literal membership, ranking, counting, and pagination over the full set in
// JS. In particular %, _, and backslash have no wildcard meaning here.
async function readAllDocuments(
  strapi: Core.Strapi,
  uid: string,
  options: {
    status: "published";
    filters: Record<string, any>;
    fields: string[];
    populate: Record<string, any>;
  },
): Promise<any[]> {
  const documents: any[] = [];
  let start = 0;
  let previousFullBatch = "";
  for (;;) {
    const batch = await strapi.documents(uid as any).findMany({
      ...options,
      sort: [{ documentId: "asc" }],
      start,
      limit: FALLBACK_READ_BATCH_SIZE,
    } as any);
    if (!Array.isArray(batch)) {
      throw new Error(`Search fallback ${uid} read did not return an array`);
    }
    documents.push(...batch);
    if (batch.length < FALLBACK_READ_BATCH_SIZE) break;

    // Guard against an adapter silently ignoring `start`, which would
    // otherwise spin forever and repeatedly append the same page.
    const signature = [
      batch.length,
      String(batch[0]?.documentId ?? batch[0]?.id ?? ""),
      String(batch.at(-1)?.documentId ?? batch.at(-1)?.id ?? ""),
    ].join(":");
    if (signature === previousFullBatch) {
      throw new Error(`Search fallback ${uid} pagination did not advance`);
    }
    previousFullBatch = signature;
    start += FALLBACK_READ_BATCH_SIZE;
  }
  return documents;
}

function cachedFallbackRead(
  cache: FallbackRequestCache,
  key: string,
  load: () => Promise<any[]>,
): Promise<any[]> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = load();
  cache.set(key, pending);
  return pending;
}

function fallbackEntities(
  strapi: Core.Strapi,
  config: EntityConfig,
  query: string,
  cache: FallbackRequestCache,
): Promise<any[]> {
  return cachedFallbackRead(cache, `entity:${config.key}`, async () => {
    const needles = searchNeedles(query);
    const documents = await readAllDocuments(strapi, config.uid, {
      status: "published",
      filters: {},
      fields: entityFields(config),
      populate: { [config.mediaField]: true },
    });
    return documents.filter((document) => entityMatches(document, needles));
  });
}

function fallbackOffers(
  strapi: Core.Strapi,
  kind: OfferKind,
  query: string,
  cache: FallbackRequestCache,
  nowIso: string,
): Promise<any[]> {
  return cachedFallbackRead(cache, `offer:${kind}`, async () => {
    const needles = searchNeedles(query);
    const documents = await readAllDocuments(
      strapi,
      kind === "coupon" ? "api::coupon.coupon" : "api::deal.deal",
      kind === "coupon"
        ? {
            status: "published",
            filters: publishedOnlyFilters(nowIso),
            fields: COUPON_FIELDS,
            populate: couponPopulate,
          }
        : {
            status: "published",
            filters: publishedOnlyFilters(nowIso),
            fields: DEAL_FIELDS,
            populate: dealPopulate,
          },
    );
    return documents.filter((document) =>
      offerMatches(document, kind, needles),
    );
  });
}

function rankOfferDocuments(
  items: any[],
  kind: OfferKind,
  query: string,
) {
  return rank(
    items,
    query,
    (item) => [
      { value: String(item?.title ?? ""), shift: 0 },
      ...(kind === "coupon" && typeof item?.code === "string"
        ? [{ value: item.code, shift: 0 }]
        : []),
      ...relatedEntities(item).map((relation) => ({
        value: String(relation?.name ?? ""),
        shift: RELATION_TIER_SHIFT,
      })),
    ],
    (item) => String(item?.title ?? ""),
  );
}

// ── Ranked-SQL execution (Postgres only) ────────────────────────────────
// Two-step pattern: raw SQL returns exactly the page of ranked document ids,
// then only those ids are hydrated through the document service (same
// fields/populate as the fallback finders) and reordered to the SQL order.

type PageWindow = {
  limit: number;
  offset: number;
  // Preview-only over-fetch (PREVIEW_BACKFILL): extra ranked rows fetched
  // beyond `limit` so null-mapping or visibility-dropped rows backfill
  // instead of shrinking the list. Undefined on group pages — pagination
  // must not shift, so only preview backfills; a dropped row on a paged
  // request shortens that page instead.
  lookahead?: number;
};

// Per-request phase accounting for slow-search diagnostics. Requests fan out
// concurrently (Promise.all across groups), so the sums are cumulative
// busy-time per phase, not wall time — their ratio says which phase dominates
// a slow request. Threaded via AsyncLocalStorage so the many helper
// signatures stay untouched. Logging is bounded to requests slower than
// SEARCH_SLOW_LOG_MS (default 500ms, 0 disables) and never includes the
// query text.
const SEARCH_SLOW_LOG_MS = Number(process.env.SEARCH_SLOW_LOG_MS ?? 500);
type SearchPhaseStats = {
  sql: number;
  sqlCalls: number;
  hydrate: number;
  hydrateCalls: number;
};
const searchPhaseStorage = new AsyncLocalStorage<SearchPhaseStats>();

function recordPhase(phase: "sql" | "hydrate", startedAt: number) {
  const stats = searchPhaseStorage.getStore();
  if (!stats) return;
  stats[phase] += Date.now() - startedAt;
  stats[phase === "sql" ? "sqlCalls" : "hydrateCalls"] += 1;
}

function rankedConnection(strapi: Core.Strapi) {
  const connection = (strapi.db as any)?.connection;
  return connection && isPostgresClient(connection?.client?.config?.client)
    ? connection
    : null;
}

async function rankedRows(connection: any, query: SqlQuery): Promise<any[]> {
  const startedAt = Date.now();
  try {
    const result = await connection.raw(query.sql, query.bindings);
    return result?.rows ?? [];
  } finally {
    recordPhase("sql", startedAt);
  }
}

async function rankedDocumentIds(
  connection: any,
  query: SqlQuery,
): Promise<string[]> {
  return (await rankedRows(connection, query)).map((row) =>
    String(row.document_id),
  );
}

async function rankedTotal(connection: any, query: SqlQuery): Promise<number> {
  const rows = await rankedRows(connection, query);
  return Number(rows[0]?.total ?? 0);
}

// Hydration runs after the ranked-ID query, so a row can change state in
// between (offer expires or unpublishes, entity loses its publish). The
// caller's visibility filters are re-applied here so such a row is dropped
// instead of served. Dropped ids still shrink the page — there is no
// backfill at this layer; preview covers the gap with its PageWindow
// lookahead over-fetch, while paged groups serve one short page until the
// next request re-ranks.
async function hydrateByDocumentId(
  strapi: Core.Strapi,
  uid: string,
  documentIds: string[],
  options: {
    fields: string[];
    populate: Record<string, any>;
    visibility: Record<string, any>;
  },
) {
  if (documentIds.length === 0) return [];
  const startedAt = Date.now();
  const documents = await strapi
    .documents(uid as any)
    .findMany({
      filters: {
        $and: [{ documentId: { $in: documentIds } }, options.visibility],
      },
      fields: options.fields,
      populate: options.populate,
      limit: documentIds.length,
    } as any)
    .finally(() => recordPhase("hydrate", startedAt));
  const order = new Map(documentIds.map((id, index) => [id, index]));
  return [...documents].sort(
    (a: any, b: any) =>
      (order.get(String(a?.documentId)) ?? 0) -
      (order.get(String(b?.documentId)) ?? 0),
  );
}

// ── Bootstrap mode selection and diagnostics ────────────────────────────
// The request path never probes capabilities or changes mode. Strapi's
// bootstrap fixes the mode from the configured database dialect alone.
// pg_trgm and its expected indexes are observed separately because they are
// performance aids, never correctness prerequisites.
export type SearchMode = "postgres-sql" | "query-engine";
export type InvalidExpectedIndex = { name: string; reason: string };
export type SearchRuntimeStatus = {
  mode: SearchMode;
  pgTrgmAvailable: boolean;
  missingExpectedIndexes: string[];
  invalidExpectedIndexes: InvalidExpectedIndex[];
};

type SearchRuntime = { status: SearchRuntimeStatus; initialized: boolean };
let searchRuntimes = new WeakMap<object, SearchRuntime>();

export function configureSearchRuntime(
  strapi: Core.Strapi,
): SearchRuntimeStatus {
  const mode: SearchMode = rankedConnection(strapi)
    ? "postgres-sql"
    : "query-engine";
  const status: SearchRuntimeStatus = {
    mode,
    pgTrgmAvailable: false,
    missingExpectedIndexes:
      mode === "postgres-sql" ? [...EXPECTED_SEARCH_INDEXES] : [],
    invalidExpectedIndexes: [],
  };
  searchRuntimes.set(strapi as object, { status, initialized: false });
  return {
    ...status,
    missingExpectedIndexes: [...status.missingExpectedIndexes],
    invalidExpectedIndexes: [],
  };
}

function runtimeFor(strapi: Core.Strapi): SearchRuntime {
  const runtime = searchRuntimes.get(strapi as object);
  if (!runtime) {
    throw new Error(
      "Search runtime was not initialized during Strapi bootstrap",
    );
  }
  return runtime;
}

function resultRows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function configuredDatabaseSchema(
  strapi: Core.Strapi,
  connection: any,
): string | null {
  const configured =
    (strapi as any)?.config?.get?.("database.connection.connection.schema") ??
    connection?.client?.config?.connection?.schema;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : null;
}

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

async function resolveSearchTableSchema(
  strapi: Core.Strapi,
  connection: any,
): Promise<string | null> {
  const configuredSchema = configuredDatabaseSchema(strapi, connection);
  const tables = Array.from(
    new Set(EXPECTED_SEARCH_INDEX_DEFINITIONS.map(({ table }) => table)),
  );
  const relationNames = tables.map((table) =>
    configuredSchema
      ? `${quotedIdentifier(configuredSchema)}.${quotedIdentifier(table)}`
      : quotedIdentifier(table),
  );
  const result = await connection.raw(
    "WITH candidates(relation_name) AS (SELECT unnest(?::text[])) " +
      "SELECT table_namespace.nspname AS schema_name " +
      "FROM candidates " +
      "JOIN pg_class table_class " +
      "ON table_class.oid = to_regclass(candidates.relation_name) " +
      "JOIN pg_namespace table_namespace " +
      "ON table_namespace.oid = table_class.relnamespace " +
      "WHERE table_class.relkind IN ('r', 'p') " +
      "GROUP BY table_namespace.nspname " +
      "HAVING count(*) = ? " +
      "LIMIT 1",
    [relationNames, tables.length],
  );
  return oneString(resultRows(result)[0]?.schema_name);
}

function logSearchDiagnosticProblem(strapi: Core.Strapi, message: string) {
  const log = (strapi as any).log;
  if (process.env.NODE_ENV === "production") log?.error?.(message);
  else log?.warn?.(message);
}

function canonicalIndexExpression(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, "")
    .replace(/::(?:text|charactervarying)/giu, "")
    .replace(/"/gu, "")
    .replace(/\(([a-z_][a-z0-9_$]*)\)/giu, "$1")
    .replace(/^translate(?=\()/iu, "translate");
}

function expectedIndexExpression(column: string): string {
  return (
    `translate(${column},` +
    `'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`
  );
}

function invalidIndexReason(
  row: any,
  expected: (typeof EXPECTED_SEARCH_INDEX_DEFINITIONS)[number],
  pgTrgmSchema: string | null,
): string | null {
  const reasons: string[] = [];
  const expectedSchema = String(row?.expected_schema ?? "");
  if (
    String(row?.table_schema ?? "") !== expectedSchema ||
    String(row?.table_name ?? "") !== expected.table
  ) {
    reasons.push(`wrong table; expected ${expectedSchema}.${expected.table}`);
  }
  if (String(row?.access_method ?? "") !== "gin") {
    reasons.push("access method is not GIN");
  }
  if (Number(row?.key_count) !== 1) {
    reasons.push("expected exactly one indexed expression");
  }
  if (
    canonicalIndexExpression(row?.expression) !==
    expectedIndexExpression(expected.column)
  ) {
    reasons.push(
      `wrong expression; expected deterministic ASCII fold of ${expected.column}`,
    );
  }
  if (String(row?.opclass_name ?? "") !== "gin_trgm_ops") {
    reasons.push("operator class is not gin_trgm_ops");
  } else if (!pgTrgmSchema) {
    reasons.push("pg_trgm schema is unavailable; operator class is unverifiable");
  } else if (String(row?.opclass_schema ?? "") !== pgTrgmSchema) {
    reasons.push(`gin_trgm_ops is not from ${pgTrgmSchema}`);
  }
  if (row?.predicate != null) reasons.push("index is partial");
  if (row?.indisvalid !== true) reasons.push("index is not valid");
  if (row?.indisready !== true) reasons.push("index is not ready");
  return reasons.length > 0 ? reasons.join("; ") : null;
}

export async function initializeSearchRuntime(
  strapi: Core.Strapi,
): Promise<SearchRuntimeStatus> {
  const existing = searchRuntimes.get(strapi as object);
  if (existing?.initialized) return searchRuntimeStatus(strapi);
  configureSearchRuntime(strapi);
  const runtime = runtimeFor(strapi);
  if (runtime.status.mode === "query-engine") {
    runtime.initialized = true;
    (strapi as any).log?.info?.("[search] mode=query-engine");
    return searchRuntimeStatus(strapi);
  }

  const connection = rankedConnection(strapi)!;
  let pgTrgmSchema: string | null = null;
  try {
    const extensionResult = await connection.raw(
      "SELECT extension_namespace.nspname AS schema_name " +
        "FROM pg_extension ext " +
        "JOIN pg_namespace extension_namespace " +
        "ON extension_namespace.oid = ext.extnamespace " +
        "WHERE ext.extname = 'pg_trgm'",
    );
    pgTrgmSchema = oneString(resultRows(extensionResult)[0]?.schema_name);
  } catch (error) {
    logSearchDiagnosticProblem(
      strapi,
      "[search] could not inspect pg_trgm: " +
        ((error as Error)?.message ?? String(error)),
    );
  }

  let tableSchema: string | null = null;
  try {
    tableSchema = await resolveSearchTableSchema(strapi, connection);
    if (!tableSchema) {
      logSearchDiagnosticProblem(
        strapi,
        "[search] could not resolve the Strapi table schema for search index diagnostics",
      );
    }
  } catch (error) {
    logSearchDiagnosticProblem(
      strapi,
      "[search] could not resolve the Strapi table schema: " +
        ((error as Error)?.message ?? String(error)),
    );
  }

  let indexRows: any[] = [];
  if (tableSchema) {
    try {
      const result = await connection.raw(
        "SELECT index_class.relname AS indexname, " +
          "?::text AS expected_schema, " +
          "table_namespace.nspname AS table_schema, " +
          "table_class.relname AS table_name, " +
          "access_method.amname AS access_method, " +
          "index_state.indnkeyatts AS key_count, " +
          "pg_get_indexdef(index_state.indexrelid, 1, true) AS expression, " +
          "opclass.opcname AS opclass_name, " +
          "opclass_namespace.nspname AS opclass_schema, " +
          "pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate, " +
          "index_state.indisvalid, index_state.indisready " +
          "FROM pg_index index_state " +
          "JOIN pg_class index_class ON index_class.oid = index_state.indexrelid " +
          "JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace " +
          "JOIN pg_class table_class ON table_class.oid = index_state.indrelid " +
          "JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace " +
          "JOIN pg_am access_method ON access_method.oid = index_class.relam " +
          "LEFT JOIN pg_opclass opclass ON opclass.oid = index_state.indclass[0] " +
          "LEFT JOIN pg_namespace opclass_namespace ON opclass_namespace.oid = opclass.opcnamespace " +
          "WHERE index_namespace.nspname = ? " +
          "AND index_class.relname = ANY(?::text[])",
        [tableSchema, tableSchema, [...EXPECTED_SEARCH_INDEXES]],
      );
      indexRows = resultRows(result);
    } catch (error) {
      logSearchDiagnosticProblem(
        strapi,
        "[search] could not inspect expected indexes: " +
          ((error as Error)?.message ?? String(error)),
      );
    }
  }

  const byName = new Map(
    indexRows.map((row) => [String(row?.indexname ?? ""), row]),
  );
  const missingExpectedIndexes: string[] = [];
  const invalidExpectedIndexes: InvalidExpectedIndex[] = [];
  for (const expected of EXPECTED_SEARCH_INDEX_DEFINITIONS) {
    const row = byName.get(expected.name);
    if (!row) {
      missingExpectedIndexes.push(expected.name);
      continue;
    }
    const reason = invalidIndexReason(row, expected, pgTrgmSchema);
    if (reason) invalidExpectedIndexes.push({ name: expected.name, reason });
  }

  runtime.status = {
    mode: "postgres-sql",
    pgTrgmAvailable: pgTrgmSchema !== null,
    missingExpectedIndexes,
    invalidExpectedIndexes,
  };
  runtime.initialized = true;
  const status = searchRuntimeStatus(strapi);
  if (
    !status.pgTrgmAvailable ||
    status.missingExpectedIndexes.length > 0 ||
    status.invalidExpectedIndexes.length > 0
  ) {
    logSearchDiagnosticProblem(
      strapi,
      `[search] mode=${status.mode} pg_trgm=${status.pgTrgmAvailable ? "available" : "missing"}; ` +
        `missing expected indexes: ${status.missingExpectedIndexes.join(", ") || "none"}; ` +
        `invalid expected indexes: ${status.invalidExpectedIndexes
          .map(({ name, reason }) => `${name} (${reason})`)
          .join(", ") || "none"}. ` +
        `Search results remain correct, but may be slow. ` +
        `Automatic reconciliation runs after schema sync on every Strapi boot and will retry on the next boot; ` +
        `ensure the application database role may create pg_trgm and indexes if this persists.`,
    );
  } else {
    (strapi as any).log?.info?.(
      `[search] mode=${status.mode} pg_trgm=available missing_indexes=0 invalid_indexes=0`,
    );
  }
  return status;
}

export function searchRuntimeStatus(
  strapi: Core.Strapi,
): SearchRuntimeStatus {
  const status = runtimeFor(strapi).status;
  return {
    ...status,
    missingExpectedIndexes: [...status.missingExpectedIndexes],
    invalidExpectedIndexes: status.invalidExpectedIndexes.map((index) => ({
      ...index,
    })),
  };
}

// Test-only reset for suites that deliberately reuse one mock Strapi object.
export function resetSearchRuntime() {
  searchRuntimes = new WeakMap<object, SearchRuntime>();
}

function configuredSqlConnection(strapi: Core.Strapi) {
  if (runtimeFor(strapi).status.mode === "query-engine") return null;
  const connection = rankedConnection(strapi);
  if (!connection) {
    throw new Error(
      "Search was bootstrapped for Postgres but its connection is unavailable",
    );
  }
  return connection;
}

async function withSearchMode<T>(
  strapi: Core.Strapi,
  ranked: (connection: any) => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  const connection = configuredSqlConnection(strapi);
  if (!connection) return fallback();
  try {
    return await ranked(connection);
  } catch (error) {
    // After bootstrap selects Postgres, a SQL failure is a real error: log it
    // and let the request fail like any other service error. Falling back here
    // would silently serve this page from a different scorer than its
    // neighbours (the pagination-reorder bug the fixed mode prevents).
    (strapi as any).log?.error?.(
      "search: Postgres SQL failed (" + ((error as Error)?.message ?? "") + ")",
    );
    throw error;
  }
}

async function entityPage(
  strapi: Core.Strapi,
  config: EntityConfig,
  query: string,
  window: PageWindow,
  fallbackCache: FallbackRequestCache,
) {
  return withSearchMode(
    strapi,
    async (connection) => {
      const ids = await rankedDocumentIds(
        connection,
        entityRankedQuery(config.key, searchNeedles(query), {
          limit: window.limit + (window.lookahead ?? 0),
          offset: window.offset,
        }),
      );
      const documents = await hydrateByDocumentId(strapi, config.uid, ids, {
        fields: entityFields(config),
        populate: { [config.mediaField]: true },
        // Same published constraint as the ranked SQL WHERE.
        visibility: { publishedAt: { $notNull: true } },
      });
      return documents
        .map((item) => mapEntity(item, config))
        .filter(Boolean)
        .slice(0, window.limit);
    },
    async () => {
      const documents = await fallbackEntities(
        strapi,
        config,
        query,
        fallbackCache,
      );
      const ranked = rank(
        documents,
        query,
        (item) => [{ value: item?.name ?? "", shift: 0 }],
        (item) => item?.name ?? "",
      );
      // Preview (lookahead set) maps before slicing so a null-mapping row
      // backfills from the full matching set; paged groups slice first —
      // their LIMIT/OFFSET are exact and must not shift when a row maps to
      // null, so only preview backfills.
      if (window.lookahead !== undefined) {
        return ranked
          .map((item) => mapEntity(item, config))
          .filter(Boolean)
          .slice(0, window.limit);
      }
      return ranked
        .slice(window.offset, window.offset + window.limit)
        .map((item) => mapEntity(item, config))
        .filter(Boolean);
    },
  );
}

async function entityTotal(
  strapi: Core.Strapi,
  config: EntityConfig,
  query: string,
  fallbackCache: FallbackRequestCache,
) {
  return withSearchMode(
    strapi,
    (connection) =>
      rankedTotal(connection, entityCountQuery(config.key, searchNeedles(query))),
    async () =>
      (await fallbackEntities(strapi, config, query, fallbackCache)).length,
  );
}

// Returns mapped offer hits in ranked, paged order.
async function offerPage(
  strapi: Core.Strapi,
  kind: OfferKind,
  query: string,
  window: PageWindow,
  fallbackCache: FallbackRequestCache,
  nowIso: string,
) {
  return withSearchMode(
    strapi,
    async (connection) => {
      const ids = await rankedDocumentIds(
        connection,
        offerRankedQuery(
          kind,
          searchNeedles(query),
          {
            limit: window.limit + (window.lookahead ?? 0),
            offset: window.offset,
          },
          nowIso,
        ),
      );
      const documents = await hydrateByDocumentId(
        strapi,
        kind === "coupon" ? "api::coupon.coupon" : "api::deal.deal",
        ids,
        // Re-apply the same contentStatus/expiresAt visibility as the ranked
        // SQL WHERE while hydrating ranked ids.
        kind === "coupon"
          ? {
              fields: COUPON_FIELDS,
              populate: couponPopulate,
              visibility: publishedOnlyFilters(nowIso),
            }
          : {
              fields: DEAL_FIELDS,
              populate: dealPopulate,
              visibility: publishedOnlyFilters(nowIso),
            },
      );
      return documents
        .map((item) => mapOffer(item, kind))
        .filter(Boolean)
        .slice(0, window.limit);
    },
    async () => {
      const documents = await fallbackOffers(
        strapi,
        kind,
        query,
        fallbackCache,
        nowIso,
      );
      const ranked = rankOfferDocuments(documents, kind, query);
      if (window.lookahead !== undefined) {
        return ranked
          .map((item) => mapOffer(item, kind))
          .filter(Boolean)
          .slice(0, window.limit);
      }
      return ranked
        .slice(window.offset, window.offset + window.limit)
        .map((item) => mapOffer(item, kind))
        .filter(Boolean);
    },
  );
}

async function offerTotal(
  strapi: Core.Strapi,
  kind: OfferKind,
  query: string,
  fallbackCache: FallbackRequestCache,
  nowIso: string,
) {
  return withSearchMode(
    strapi,
    (connection) =>
      rankedTotal(
        connection,
        offerCountQuery(kind, searchNeedles(query), nowIso),
      ),
    async () =>
      (await fallbackOffers(strapi, kind, query, fallbackCache, nowIso)).length,
  );
}

function emptyResponse(query: string): any {
  return {
    query,
    suggestions: [],
    stores: [],
    brands: [],
    categories: [],
    banks: [],
    coupons: [],
    deals: [],
    totals: {
      stores: 0,
      brands: 0,
      categories: 0,
      banks: 0,
      coupons: 0,
      deals: 0,
    },
    pagination: null,
    hasMore: {
      stores: false,
      brands: false,
      categories: false,
      banks: false,
      coupons: false,
      deals: false,
    },
    partialSources: [],
  };
}

async function preview(
  strapi: Core.Strapi,
  request: SearchRequest,
  nowIso: string,
) {
  const response = emptyResponse(request.query);
  const fallbackCache: FallbackRequestCache = new Map();
  const entityWindow = {
    limit: PREVIEW_ENTITY_LIMIT,
    offset: 0,
    lookahead: PREVIEW_BACKFILL,
  };
  const offerWindow = {
    limit: PREVIEW_OFFER_LIMIT,
    offset: 0,
    lookahead: PREVIEW_BACKFILL,
  };
  const [
    entityResults,
    couponItems,
    couponCount,
    dealItems,
    dealCount,
  ] = await Promise.all([
    Promise.all(
      ENTITIES.map(async (config) => {
        const [items, total] = await Promise.all([
          entityPage(strapi, config, request.query, entityWindow, fallbackCache),
          entityTotal(strapi, config, request.query, fallbackCache),
        ]);
        return [config, items, total] as const;
      }),
    ),
    offerPage(
      strapi,
      "coupon",
      request.query,
      offerWindow,
      fallbackCache,
      nowIso,
    ),
    offerTotal(strapi, "coupon", request.query, fallbackCache, nowIso),
    offerPage(
      strapi,
      "deal",
      request.query,
      offerWindow,
      fallbackCache,
      nowIso,
    ),
    offerTotal(strapi, "deal", request.query, fallbackCache, nowIso),
  ]);

  for (const [config, items, total] of entityResults) {
    response[config.key] = items;
    response.totals[config.key] = total;
    response.hasMore[config.key] = total > PREVIEW_ENTITY_LIMIT;
  }

  response.coupons = couponItems.map(toPublicOffer);
  response.deals = dealItems.map(toPublicOffer);
  response.totals.coupons = couponCount;
  response.totals.deals = dealCount;
  response.hasMore.coupons = couponCount > PREVIEW_OFFER_LIMIT;
  response.hasMore.deals = response.totals.deals > PREVIEW_OFFER_LIMIT;

  const matchedName =
    response.stores[0]?.name ??
    response.brands[0]?.name ??
    response.categories[0]?.name ??
    response.banks[0]?.name ??
    request.query;
  const labels = [
    matchedName + " coupons",
    matchedName + " deals",
    request.query + " promo codes",
    request.query + " offers",
  ];
  response.suggestions = Array.from(new Set(labels.map(normalizeQuery)))
    .slice(0, 4)
    .map((label, index) => ({
      id: "suggestion-" + (index + 1),
      label,
      query: label,
    }));

  return response;
}

async function group(
  strapi: Core.Strapi,
  request: SearchRequest,
  nowIso: string,
) {
  const response = emptyResponse(request.query);
  const fallbackCache: FallbackRequestCache = new Map();
  const window = {
    limit: request.pageSize,
    offset: (request.page - 1) * request.pageSize,
  };
  let total = 0;

  if (request.group === "coupons" || request.group === "deals") {
    const [couponCount, dealCount] = await Promise.all([
      offerTotal(strapi, "coupon", request.query, fallbackCache, nowIso),
      offerTotal(strapi, "deal", request.query, fallbackCache, nowIso),
    ]);
    response.totals.coupons = couponCount;
    response.totals.deals = dealCount;

    if (request.group === "coupons") {
      const items = await offerPage(
        strapi,
        "coupon",
        request.query,
        window,
        fallbackCache,
        nowIso,
      );
      response.coupons = items.map(toPublicOffer);
      total = couponCount;
    } else {
      const items = await offerPage(
        strapi,
        "deal",
        request.query,
        window,
        fallbackCache,
        nowIso,
      );
      response.deals = items.map(toPublicOffer);
      total = dealCount;
    }
  } else {
    const config = ENTITIES.find((item) => item.key === request.group);
    if (config) {
      const [items, entityCount] = await Promise.all([
        entityPage(strapi, config, request.query, window, fallbackCache),
        entityTotal(strapi, config, request.query, fallbackCache),
      ]);
      response[config.key] = items;
      response.totals[config.key] = entityCount;
      total = entityCount;
    }
  }

  // page is clamped to MAX_PAGE in parseRequest; advertise only reachable
  // pages so hasMore goes false at the clamp instead of looping forever.
  const pageCount = Math.min(Math.ceil(total / request.pageSize), MAX_PAGE);
  response.pagination = {
    group: request.group,
    page: request.page,
    pageSize: request.pageSize,
    pageCount,
    total,
  };
  if (request.group) {
    response.hasMore[request.group] = request.page < pageCount;
  }
  return response;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  parseRequest,
  status() {
    return searchRuntimeStatus(strapi);
  },
  async search(request: SearchRequest) {
    const nowIso = new Date().toISOString();
    const stats: SearchPhaseStats = {
      sql: 0,
      sqlCalls: 0,
      hydrate: 0,
      hydrateCalls: 0,
    };
    const startedAt = Date.now();
    try {
      return await searchPhaseStorage.run(stats, () =>
        request.mode === "group"
          ? group(strapi, request, nowIso)
          : preview(strapi, request, nowIso),
      );
    } finally {
      const totalMs = Date.now() - startedAt;
      if (SEARCH_SLOW_LOG_MS > 0 && totalMs >= SEARCH_SLOW_LOG_MS) {
        (strapi as any).log?.info?.(
          `[search] slow ${request.mode} total=${totalMs}ms ` +
            `sql=${stats.sql}ms/${stats.sqlCalls}q ` +
            `hydrate=${stats.hydrate}ms/${stats.hydrateCalls}q ` +
            "(phase sums are concurrent busy-time, not wall time)",
        );
      }
    }
  },
});
