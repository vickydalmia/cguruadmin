import type { Core } from "@strapi/strapi";
import { publishedOnlyFilters } from "../../../utils/content-status";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 80;
const PREVIEW_ENTITY_LIMIT = 7;
const PREVIEW_OFFER_LIMIT = 3;
const MAX_PAGE = 20;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_CANDIDATES = MAX_PAGE * MAX_PAGE_SIZE;

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
    mediaField === "logo" ? ["name", "slug", "logoAlt"] : ["name", "slug"],
  populate: { [mediaField]: true },
});
const relations = Object.fromEntries(
  ENTITIES.map((config) => [config.key, relationRef(config.mediaField)]),
) as Record<EntityConfig["key"], ReturnType<typeof relationRef>>;
const couponPopulate = { ...relations, image: true };
const dealPopulate = {
  ...relations,
  primaryStore: relationRef("logo"),
  dealImage: true,
};

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
      message: "Search query must be between 2 and 80 characters",
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

  const byWidth = new Map<number, string>();
  for (const [formatName, format] of Object.entries(
    media?.formats ?? {},
  ) as Array<[string, any]>) {
    // A plain img srcset cannot advertise mixed AVIF and WebP candidates.
    // Keep the universally usable WebP/fallback variants here.
    if (formatName.endsWith("_avif")) continue;
    const url = safeHref(format?.url);
    const width = Number(format?.width);
    if (url && Number.isFinite(width) && width > 0) byWidth.set(width, url);
  }

  const srcset = Array.from(byWidth.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([width, url]) => url + " " + width + "w")
    .join(", ");

  return {
    src,
    srcset: srcset || null,
    width: Number(media?.width) > 0 ? Number(media.width) : null,
    height: Number(media?.height) > 0 ? Number(media.height) : null,
    alt: cleanText(media?.alternativeText, 160) ?? fallbackAlt,
  };
}

function relatedEntities(document: any): any[] {
  return [
    ...(Array.isArray(document?.stores) ? document.stores : []),
    ...(document?.primaryStore ? [document.primaryStore] : []),
    ...(Array.isArray(document?.brands) ? document.brands : []),
    ...(Array.isArray(document?.categories) ? document.categories : []),
    ...(Array.isArray(document?.banks) ? document.banks : []),
  ];
}

function offerOwner(document: any, source: "coupon" | "deal") {
  if (source === "deal" && document?.primaryStore) {
    return document.primaryStore;
  }
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
  const lower = q.toLocaleLowerCase();

  if (lower.endsWith("ies") && lower.length - 3 >= 3) {
    variants.add(q.slice(0, -3) + "y");
  } else if (/(?:ch|sh|x|z)es$/u.test(lower) && lower.length - 2 >= 3) {
    variants.add(q.slice(0, -2));
  } else if (
    lower.endsWith("s") &&
    !/(?:ss|us|is)$/u.test(lower) &&
    lower.length - 1 >= 3
  ) {
    variants.add(q.slice(0, -1));
  }
  return [...variants];
}

// SQL needles: a shorter variant substring-subsumes a longer one for
// $containsi (rows matching "mobiles" all match "mobile"), so drop any
// variant that contains another — fewer OR clauses, identical row set.
function filterNeedles(variants: string[]): string[] {
  const lowered = variants.map((variant) => variant.toLocaleLowerCase());
  return variants.filter((_, index) =>
    lowered.every(
      (other, otherIndex) =>
        otherIndex === index || !lowered[index].includes(other),
    ),
  );
}

function relevanceForNeedle(candidate: string, needle: string): number {
  if (candidate === needle) return 0;
  if (candidate.startsWith(needle)) return 1;
  if (candidate.includes(" " + needle)) return 2;
  return candidate.includes(needle) ? 3 : 4;
}

const NO_MATCH_RELEVANCE = 10;

// Matches on the query AS TYPED rank in tiers 0-3; matches only via a
// singular/plural variant rank in tiers 4-6 (variant tier + 3), so a variant
// hit can never outrank a literal one; no match at all sinks to the bottom.
function relevanceForVariants(value: string, variants: string[]): number {
  const candidate = value.normalize("NFKC").toLocaleLowerCase();
  const literal = relevanceForNeedle(candidate, variants[0].toLocaleLowerCase());
  if (literal < 4) return literal;

  let best = NO_MATCH_RELEVANCE;
  for (const variant of variants.slice(1)) {
    const tier = relevanceForNeedle(candidate, variant.toLocaleLowerCase());
    if (tier < 4) best = Math.min(best, tier + 3);
  }
  return best;
}

function relevance(value: string, query: string): number {
  return relevanceForVariants(value, queryVariants(query));
}

function time(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function rank<T extends Record<string, any>>(
  items: T[],
  query: string,
  label: (item: T) => string,
): T[] {
  // Variants are computed once and each item scored once (not per comparison)
  // — the comparator runs O(n log n) times over up to 1000 candidates.
  const variants = queryVariants(query);
  const scores = new Map<T, number>(
    items.map((item) => [item, relevanceForVariants(label(item), variants)]),
  );
  return [...items].sort((a, b) => {
    const byMatch = scores.get(a)! - scores.get(b)!;
    if (byMatch) return byMatch;
    const byPopularity =
      Number(Boolean(b?.isPopular)) - Number(Boolean(a?.isPopular));
    if (byPopularity) return byPopularity;
    const byDate =
      time(b?.publishedAt ?? b?.updatedAt) -
      time(a?.publishedAt ?? a?.updatedAt);
    if (byDate) return byDate;
    return String(a?.documentId ?? a?.id ?? "").localeCompare(
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
    media: mapMedia(document?.[config.mediaField], document?.logoAlt ?? name),
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
      type === "coupon" ? (ownerName ?? name) : name,
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
            logo: mapMedia(ownerMedia, owner?.logoAlt ?? ownerName),
          }
        : null,
    rankText: [
      name,
      ...relatedEntities(document).map((item) => item?.name),
    ].join(" "),
    isPopular: Boolean(document?.isPopular),
    sortDate: document?.publishedAt ?? document?.updatedAt ?? null,
  };
}

function toPublicOffer(hit: any) {
  if (!hit) return null;
  const { rankText, isPopular, sortDate, ...result } = hit;
  return result;
}

function offerFilters(query: string) {
  const clauses = filterNeedles(queryVariants(query)).flatMap((variant) => {
    const contains = { $containsi: variant };
    return [
      { title: contains },
      { stores: { name: contains } },
      { brands: { name: contains } },
      { categories: { name: contains } },
      { banks: { name: contains } },
    ];
  });
  return {
    $and: [publishedOnlyFilters(), { $or: clauses }],
  };
}

function nameContainsFilter(query: string) {
  const needles = filterNeedles(queryVariants(query));
  return {
    $or: needles.map((variant) => ({ name: { $containsi: variant } })),
  };
}

function productDealFilters(query: string) {
  return {
    $and: [
      offerFilters(query),
      { salePrice: { $notNull: true, $gt: 0 } },
    ],
  };
}

async function findEntities(
  strapi: Core.Strapi,
  config: EntityConfig,
  query: string,
  limit: number,
) {
  return await strapi.documents(config.uid as any).findMany({
    filters: nameContainsFilter(query),
    fields: [
      "name",
      "slug",
      ...(config.mediaField === "logo" ? ["logoAlt"] : []),
    ],
    populate: { [config.mediaField]: true },
    // Deterministic order: without it Postgres returns heap order, so the
    // candidate window (and thus pages) could differ between requests.
    sort: [{ name: "asc" }],
    limit,
  } as any);
}

async function countEntities(
  strapi: Core.Strapi,
  config: EntityConfig,
  query: string,
) {
  return await strapi.documents(config.uid as any).count({
    filters: nameContainsFilter(query),
  } as any);
}

async function findCoupons(strapi: Core.Strapi, query: string, limit: number) {
  return await strapi.documents("api::coupon.coupon").findMany({
    // Both code and no-code variants are Coupon-schema records. CTA wording
    // never changes the backing entity or removes it from Coupon search.
    filters: offerFilters(query),
    fields: ["title", "code", "couponType", "affiliateLink", "isPopular"],
    populate: couponPopulate,
    sort: [
      { isPopular: "desc" },
      { publishedAt: "desc" },
      { updatedAt: "desc" },
    ],
    limit,
  } as any);
}

async function countCoupons(strapi: Core.Strapi, query: string) {
  return await strapi.documents("api::coupon.coupon").count({
    filters: offerFilters(query),
  } as any);
}

async function findDeals(strapi: Core.Strapi, query: string, limit: number) {
  return await strapi.documents("api::deal.deal").findMany({
    // Search deal cards are the product-card surface from Figma. Collection
    // promos without product pricing belong to offer surfaces, not this list.
    filters: productDealFilters(query),
    fields: [
      "title",
      "affiliateLink",
      "salePrice",
      "mrp",
      "discount",
      "expiresAt",
      "isPopular",
    ],
    populate: dealPopulate,
    sort: [
      { isPopular: "desc" },
      { publishedAt: "desc" },
      { updatedAt: "desc" },
    ],
    limit,
  } as any);
}

async function countDeals(strapi: Core.Strapi, query: string) {
  return await strapi.documents("api::deal.deal").count({
    filters: productDealFilters(query),
  } as any);
}

function rankOffers(items: any[], query: string) {
  return rank(
    items.filter(Boolean),
    query,
    (item) => item?.rankText ?? item?.name ?? "",
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
    insights: [],
    totals: {
      stores: 0,
      brands: 0,
      categories: 0,
      banks: 0,
      coupons: 0,
      deals: 0,
      insights: 0,
    },
    pagination: null,
    hasMore: {
      stores: false,
      brands: false,
      categories: false,
      banks: false,
      coupons: false,
      deals: false,
      insights: false,
    },
    partialSources: [],
  };
}

async function preview(strapi: Core.Strapi, request: SearchRequest) {
  const response = emptyResponse(request.query);
  const [
    entityResults,
    coupons,
    couponCount,
    deals,
    dealCount,
  ] = await Promise.all([
    Promise.all(
      ENTITIES.map(async (config) => {
        const [documents, total] = await Promise.all([
          findEntities(strapi, config, request.query, 30),
          countEntities(strapi, config, request.query),
        ]);
        return [config, documents, total] as const;
      }),
    ),
    findCoupons(strapi, request.query, 30),
    countCoupons(strapi, request.query),
    findDeals(strapi, request.query, 30),
    countDeals(strapi, request.query),
  ]);

  for (const [config, documents, total] of entityResults) {
    const items = rank(documents, request.query, (item) => item?.name ?? "")
      .map((item) => mapEntity(item, config))
      .filter(Boolean);
    response[config.key] = items.slice(0, PREVIEW_ENTITY_LIMIT);
    response.totals[config.key] = total;
    response.hasMore[config.key] = total > PREVIEW_ENTITY_LIMIT;
  }

  const couponItems = rankOffers(
    coupons.map((item) => mapOffer(item, "coupon")),
    request.query,
  );
  const dealItems = rankOffers(
    deals.map((item) => mapOffer(item, "deal")),
    request.query,
  );

  response.coupons = couponItems
    .slice(0, PREVIEW_OFFER_LIMIT)
    .map(toPublicOffer);
  response.deals = dealItems.slice(0, PREVIEW_OFFER_LIMIT).map(toPublicOffer);
  response.totals.coupons = couponCount;
  response.totals.deals = dealCount;
  response.hasMore.coupons = couponCount > PREVIEW_OFFER_LIMIT;
  response.hasMore.deals = response.totals.deals > PREVIEW_OFFER_LIMIT;

  const matchedName =
    response.stores[0]?.name ?? response.brands[0]?.name ?? request.query;
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

async function group(strapi: Core.Strapi, request: SearchRequest) {
  const response = emptyResponse(request.query);
  const offset = (request.page - 1) * request.pageSize;
  // Rank the SAME candidate window on every page: a page-dependent window
  // gets re-ranked differently per request, shifting items across page
  // boundaries (duplicates on one page, omissions on another).
  const limit = MAX_CANDIDATES;
  let total = 0;

  if (request.group === "coupons" || request.group === "deals") {
    const [couponTotal, dealTotal] = await Promise.all([
      countCoupons(strapi, request.query),
      countDeals(strapi, request.query),
    ]);
    response.totals.coupons = couponTotal;
    response.totals.deals = dealTotal;

    if (request.group === "coupons") {
      const documents = await findCoupons(strapi, request.query, limit);
      const items = rankOffers(
        documents.map((item) => mapOffer(item, "coupon")),
        request.query,
      );
      response.coupons = items
        .slice(offset, offset + request.pageSize)
        .map(toPublicOffer);
      total = couponTotal;
    } else {
      const dealDocuments = await findDeals(strapi, request.query, limit);
      const items = rankOffers(
        dealDocuments.map((item) => mapOffer(item, "deal")),
        request.query,
      );
      response.deals = items
        .slice(offset, offset + request.pageSize)
        .map(toPublicOffer);
      total = dealTotal;
    }
  } else {
    const config = ENTITIES.find((item) => item.key === request.group);
    if (config) {
      const [documents, entityTotal] = await Promise.all([
        findEntities(strapi, config, request.query, limit),
        countEntities(strapi, config, request.query),
      ]);
      response[config.key] = rank(
        documents,
        request.query,
        (item) => item?.name ?? "",
      )
        .slice(offset, offset + request.pageSize)
        .map((item) => mapEntity(item, config))
        .filter(Boolean);
      response.totals[config.key] = entityTotal;
      total = entityTotal;
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
  async search(request: SearchRequest) {
    return request.mode === "group"
      ? group(strapi, request)
      : preview(strapi, request);
  },
});
