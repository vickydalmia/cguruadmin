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

function relevance(value: string, query: string): number {
  const candidate = value.normalize("NFKC").toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (candidate === needle) return 0;
  if (candidate.startsWith(needle)) return 1;
  if (candidate.includes(" " + needle)) return 2;
  return candidate.includes(needle) ? 3 : 4;
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
  return [...items].sort((a, b) => {
    const byMatch = relevance(label(a), query) - relevance(label(b), query);
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
  const contains = { $containsi: query };
  return {
    $and: [
      publishedOnlyFilters(),
      {
        $or: [
          { title: contains },
          { stores: { name: contains } },
          { brands: { name: contains } },
          { categories: { name: contains } },
          { banks: { name: contains } },
        ],
      },
    ],
  };
}

function productDealFilters(query: string) {
  return {
    $and: [
      offerFilters(query),
      { salePrice: { $notNull: true, $gt: 0 } },
      { mrp: { $notNull: true, $gt: 0 } },
    ],
  };
}

// Deals never come from the coupons table (they have their own content type),
// so search only surfaces real coupons: unique-type or with a non-empty code.
function couponOnlyFilter() {
  return {
    $or: [
      { couponType: { $eq: "unique" } },
      {
        $and: [{ code: { $notNull: true } }, { code: { $ne: "" } }],
      },
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
    filters: { name: { $containsi: query } },
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
    filters: { name: { $containsi: query } },
  } as any);
}

async function findCoupons(strapi: Core.Strapi, query: string, limit: number) {
  return await strapi.documents("api::coupon.coupon").findMany({
    filters: {
      $and: [offerFilters(query), couponOnlyFilter()],
    },
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
    filters: {
      $and: [offerFilters(query), couponOnlyFilter()],
    },
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
