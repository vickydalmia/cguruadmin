import type { Core } from '@strapi/strapi';
import { createHash, timingSafeEqual } from 'node:crypto';
import { publishedOnlyFilters } from '../../../utils/content-status';
import { arrayizeOfferText } from '../../../utils/offer-text';

const MAX_PAGE_SIZE = 100;
const clampPageSize = (raw: unknown, fallback: number) =>
  Math.max(1, Math.min(Number(raw) || fallback, MAX_PAGE_SIZE));

// How many drag-ordered offers lead an entity listing before newest-first
// members take over. Strapi 5 manyToMany joins carry an order column, so a
// newly connected offer lands at the TAIL of the curated order — uncapped, a
// category with 1300+ members pushed brand-new offers past page 26, far outside
// the frontend's bounded read window, so they rendered on the store page but
// never on the category page.
//
// INVARIANT: must stay <= OFFER_PAGE_SIZE * (OFFER_PAGE_CAP - 1) in the
// frontend (currently 50 * 3 = 150; see features/entity/api/get-entity-page.ts
// and requests/entity-offers-request.ts). That guarantees at least one whole
// page of newest-first content is always inside the window, so recently tagged
// offers surface no matter how large the curated relation grows.
//
// Also bounds the `documentId: { $notIn: [...] }` in the rest query to 50
// elements instead of 1300+ — that query shape is close to one that previously
// caused 504s on this database.
//
// The cap is enforced IN the relation populate query (see listEntityOffers),
// so the id-only relation read is itself bounded to 50 link-ordered rows; the
// JS slice merely re-asserts the bound.
const CURATED_HEAD_LIMIT = 50;

// Map singular entityType to plural relation field name on coupons/deals
const PLURAL_FIELD: Record<string, string> = {
  store: 'stores',
  bank: 'banks',
  category: 'categories',
  brand: 'brands',
};

const visibilityFilters = () => publishedOnlyFilters();

// Default page size for the global /offers and /deals listings (max 100 via
// clampPageSize). Matches the "24 per page" grid the frontend renders.
const DEFAULT_LIST_PAGE_SIZE = 24;
const OFFER_ID_PATTERN = /^[1-9]\d{0,14}$/;
const REDEEM_DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;
const REDEEM_UIDS = {
  coupon: 'api::coupon.coupon',
  deal: 'api::deal.deal',
} as const;
// Route inventory is an internal deployment feed, not a public listing page.
// Production has 10k+ Coupon/Deal documents, so the former 100-row batch size
// required 100+ sequential Document Service queries and regularly exceeded the
// frontend's request timeout. A larger bounded batch keeps memory predictable
// while reducing inventory assembly to roughly a dozen queries.
const ISR_ROUTE_BATCH_SIZE = 1_000;

function secureSecretMatch(actual: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

function isRedeemResolverAuthorized(ctx: any): boolean {
  const secret = process.env.ISR_ADMIN_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const authorization = String(ctx.get('authorization') || '');
  return secureSecretMatch(authorization, `Bearer ${secret}`);
}

async function listIsrOfferRoutes(
  strapi: Core.Strapi,
  uid: 'api::coupon.coupon' | 'api::deal.deal',
  kind: 'coupon' | 'deal',
): Promise<Array<{ path: string; updatedAt?: string }>> {
  const routes: Array<{ path: string; updatedAt?: string }> = [];
  let start = 0;

  while (true) {
    const items: any[] = await strapi.documents(uid).findMany({
      status: 'published',
      filters: visibilityFilters(),
      fields: ['updatedAt'] as any,
      sort: [{ id: 'asc' }] as any,
      start,
      limit: ISR_ROUTE_BATCH_SIZE,
    } as any);
    for (const item of items) {
      const id = Number(item?.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      routes.push({
        path: `/${kind}/${id}/`,
        ...(typeof item.updatedAt === 'string'
          ? { updatedAt: item.updatedAt }
          : {}),
      });
    }
    if (items.length < ISR_ROUTE_BATCH_SIZE) break;
    start += items.length;
  }

  return routes;
}

// Ordering for the global offer/deal listings: newest first. Per-entity
// listings (store/category/brand/bank) instead follow the admin-curated
// relation order — see getCouponsByEntity/getDealsByEntity.
const DEFAULT_OFFER_SORT = [
  { publishedAt: 'desc' },
  { updatedAt: 'desc' },
];

// Public-safe scalar whitelists. Richtext `content` is included since the
// `excerpt` field was removed. Homepage full-card sections also consume this
// field; compact Hero and Top Offers references intentionally omit it.
const COUPON_PUBLIC_FIELDS = [
  'title',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'badge',
  'content',
  'code',
  'couponType',
  'affiliateLink',
  'expiresAt',
  'contentStatus',
  'scheduledAt',
  'createdAt',
  'updatedAt',
  'publishedAt',
];
const DEAL_PUBLIC_FIELDS = [
  'title',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'badge',
  'content',
  'code',
  'salePrice',
  'mrp',
  'discount',
  'affiliateLink',
  'expiresAt',
  'contentStatus',
  'scheduledAt',
  'createdAt',
  'updatedAt',
  'publishedAt',
];
const COUPON_PAGE_FIELDS = COUPON_PUBLIC_FIELDS.filter(
  (field) => field !== 'affiliateLink',
);
const DEAL_PAGE_FIELDS = DEAL_PUBLIC_FIELDS.filter(
  (field) => field !== 'affiliateLink',
);
const RELATED_DEAL_PAGE_FIELDS = DEAL_PUBLIC_FIELDS.filter(
  (field) => field !== 'affiliateLink',
);
const COUPON_PAGE_RELATED_LIMIT = 4;
const COUPON_PAGE_RELATED_DEAL_LIMIT = 6;
const COUPON_PAGE_RELATED_DEAL_QUERY_LIMIT = 40;
const DEAL_PAGE_RELATED_LIMIT = 4;
const DEAL_PAGE_RELATED_QUERY_LIMIT = 40;

function isRenderableCouponPageDeal(deal: any): boolean {
  const rawPrice =
    typeof deal?.salePrice === 'string'
      ? deal.salePrice.replaceAll(',', '').trim()
      : deal?.salePrice;
  const salePrice = Number(rawPrice);
  return (
    typeof deal?.dealImage?.url === 'string' &&
    deal.dealImage.url.trim().length > 0 &&
    Number.isFinite(salePrice) &&
    salePrice > 0
  );
}

// Related-entity refs expose only name/slug (+ logo/icon media, +logoAlt for
// alt text). Nothing else about a store/bank/brand/category leaks into a listing.
const storeRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const bankRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const brandRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const categoryRef = { fields: ['name', 'slug'], populate: { icon: true } };
// Coupon populate for public listings. `uniqueCouponPool` is populated with the
// pool NAME only — its `codes` relation is never referenced, so redeemable
// unique codes can never be harvested through this endpoint.
const COUPON_PUBLIC_POPULATE = {
  image: true,
  stores: storeRef,
  banks: bankRef,
  categories: categoryRef,
  brands: brandRef,
  uniqueCouponPool: { fields: ['name'] },
};

const DEAL_PUBLIC_POPULATE = {
  dealImage: true,
  primaryStore: storeRef,
  stores: storeRef,
  banks: bankRef,
  categories: categoryRef,
  brands: brandRef,
};

const PRIMARY_ENTITY_RELATIONS = [
  ['stores', 'store'],
  ['brands', 'brand'],
  ['banks', 'bank'],
  ['categories', 'category'],
] as const;

function couponPagePrimaryEntity(coupon: any) {
  for (const [field, kind] of PRIMARY_ENTITY_RELATIONS) {
    const relation = Array.isArray(coupon?.[field]) ? coupon[field][0] : null;
    if (relation?.documentId && relation?.slug) {
      return { kind, ...relation };
    }
  }
  return null;
}

function dealPagePrimaryEntity(deal: any) {
  if (deal?.primaryStore?.documentId && deal.primaryStore.slug) {
    return { kind: 'store', ...deal.primaryStore };
  }
  return couponPagePrimaryEntity(deal);
}

// Shared driver for the global /offers and /deals listings: published-only
// filter, whitelisted fields + populate, sanitized output, and a { data,
// pagination } envelope. `sort` may be overridden via ?sort= (validated by the
// content API); otherwise falls back to DEFAULT_OFFER_SORT.
async function listPublishedOffers(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  fields: string[],
  populate: Record<string, any>,
) {
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const pageSize = clampPageSize(ctx.query.pageSize, DEFAULT_LIST_PAGE_SIZE);
  const sort = ctx.query.sort ?? DEFAULT_OFFER_SORT;
  const filters = visibilityFilters();

  const listQuery = await sanitizeDocumentQuery(strapi, ctx, uid, {
    filters,
    fields,
    populate,
    sort,
    start: (page - 1) * pageSize,
    limit: pageSize,
  });
  const countQuery = await sanitizeDocumentQuery(strapi, ctx, uid, { filters });

  const documents = strapi.documents(uid as any);
  const items = await documents.findMany(listQuery);
  const total = await documents.count(countQuery);
  const data = arrayizeOfferText(await sanitizeDocumentOutput(strapi, ctx, uid, items));

  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      pageCount: Math.ceil(total / pageSize),
    },
  };
}

// Categories carry `icon`; stores/banks/brands carry `logo`. Object-style
// populate is validated strictly, so only reference fields that exist.
const entityPopulate = (entityType: string) => ({
  [entityType === 'category' ? 'icon' : 'logo']: true,
  faqs: true,
  seo: { populate: { ogImage: true } },
  // Each entity may curate up to four Coupon-schema Top Picks. The write-time
  // validator enforces the cap; visibility filtering removes stale selections
  // before the frontend decides whether the two-Coupon fallback is needed.
  topPickCoupons: {
    fields: COUPON_PUBLIC_FIELDS,
    filters: visibilityFilters(),
    populate: COUPON_PUBLIC_POPULATE,
  },
});

function entityOfferFilters(
  entityType: string,
  documentId: string,
  entity: 'coupon' | 'deal',
) {
  if (entityType === 'store' && entity === 'deal') {
    return {
      $or: [
        { stores: { documentId } },
        { primaryStore: { documentId } },
      ],
      ...visibilityFilters(),
    };
  }
  const relationField = PLURAL_FIELD[entityType] || entityType;
  return {
    [relationField]: { documentId },
    ...visibilityFilters(),
  };
}

function contentType(strapi: Core.Strapi, uid: string) {
  return strapi.contentType(uid as any) as any;
}

async function sanitizeDocumentQuery(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  query: Record<string, any>,
) {
  const schema = contentType(strapi, uid);
  await strapi.contentAPI.validate.query(query, schema, { auth: ctx.state.auth });
  return await strapi.contentAPI.sanitize.query(query, schema, { auth: ctx.state.auth });
}

async function sanitizeDocumentOutput(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  data: any,
) {
  const schema = contentType(strapi, uid);
  return (await strapi.contentAPI.sanitize.output(data, schema, {
    auth: ctx.state.auth,
  })) as any;
}

// Return an entity's offers with the admin-curated relation (drag) order first
// — capped at CURATED_HEAD_LIMIT — then every other offer that belongs to the
// entity, newest-first, filling the rest. Editors reorder the coupons/deals
// relation on the entity's edit page; Strapi persists that order, and
// populating the relation returns offers in it. Drag positions past the cap are
// not honoured: they fall into the newest-first remainder instead (still
// counted, still reachable — see CURATED_HEAD_LIMIT for why).
//
// The "rest" matters because the drag-ordered relation is not always the full
// membership: a Store's `deals` manyToMany omits deals linked only via
// `primaryStore`. `entityOfferFilters` (the $or over stores/primaryStore for
// Store deals) is the true membership, so members not in the ordered relation
// are appended and counted — never silently dropped or under-paginated.
//
// This also subsumes the "empty relation" case: with no drag order, every offer
// comes from the newest-first member query. Returns null when the slug misses.
//
// NOTE: relies on Strapi ordering the populated relation by the link table's
// order column (getJoinTableOrderBy in @strapi/database populate/apply).
// Strapi's Document Service rejects `limit` inside a relation populate, so the
// ID-only relation is capped in JavaScript after it is fetched.
async function listEntityOffers(
  strapi: Core.Strapi,
  ctx: any,
  opts: {
    apiId: string;
    entityType: string;
    slug: string;
    relationField: 'coupons' | 'deals';
    offerUid: string;
    offerFields: string[];
    offerPopulate: Record<string, any>;
    offerKind: 'coupon' | 'deal';
    page: number;
    pageSize: number;
  },
): Promise<{ sanitizedEntity: any; offers: any[]; total: number } | null> {
  const { apiId, entityType, slug, relationField, offerUid, offerFields, offerPopulate, offerKind, page, pageSize } = opts;
  const start = (page - 1) * pageSize;

  const entityQuery = await sanitizeDocumentQuery(strapi, ctx, apiId, {
    filters: { slug },
    populate: {
      ...entityPopulate(entityType),
      [relationField]: { fields: ['documentId'], filters: visibilityFilters() },
    },
    limit: 1,
  });
  const entity = (await strapi.documents(apiId as any).findMany(entityQuery))[0];
  if (!entity) return null;

  const orderedIds: string[] = (Array.isArray(entity[relationField]) ? entity[relationField] : [])
    .map((offer: any) => offer?.documentId)
    .filter(Boolean)
    .slice(0, CURATED_HEAD_LIMIT);
  // Strip the (potentially large) id-only relation before sanitizing for output.
  delete entity[relationField];
  const sanitizedEntity = await sanitizeDocumentOutput(strapi, ctx, apiId, entity);

  // True membership (superset of the ordered relation for Store deals). The
  // "rest" is everything that belongs to the entity but is NOT in the drag
  // order — appended newest-first after the curated head.
  const memberFilters = entityOfferFilters(entityType, entity.documentId, offerKind);
  const restFilters = orderedIds.length
    ? { ...memberFilters, documentId: { $notIn: orderedIds } }
    : memberFilters;

  const restCountQuery = await sanitizeDocumentQuery(strapi, ctx, offerUid, { filters: restFilters });
  const restCount = await strapi.documents(offerUid as any).count(restCountQuery);
  const total = orderedIds.length + restCount;

  // Page = the drag-ordered slice first; newest-first members fill the rest.
  const pageOrderedIds = orderedIds.slice(start, start + pageSize);
  const remaining = pageSize - pageOrderedIds.length;

  let orderedOffers: any[] = [];
  if (pageOrderedIds.length) {
    const orderedQuery = await sanitizeDocumentQuery(strapi, ctx, offerUid, {
      fields: offerFields,
      filters: { documentId: { $in: pageOrderedIds } },
      populate: offerPopulate,
    });
    const fetched = await strapi.documents(offerUid as any).findMany(orderedQuery);
    const byId = new Map(fetched.map((offer: any) => [offer.documentId, offer]));
    orderedOffers = pageOrderedIds.map((id) => byId.get(id)).filter(Boolean);
  }

  let restOffers: any[] = [];
  if (remaining > 0 && restCount > 0) {
    // Once the ordered head is consumed, page into the newest-first remainder.
    const restStart = Math.max(0, start - orderedIds.length);
    const restQuery = await sanitizeDocumentQuery(strapi, ctx, offerUid, {
      fields: offerFields,
      filters: restFilters,
      populate: offerPopulate,
      sort: DEFAULT_OFFER_SORT,
      start: restStart,
      limit: remaining,
    });
    restOffers = await strapi.documents(offerUid as any).findMany(restQuery);
  }

  return { sanitizedEntity, offers: [...orderedOffers, ...restOffers], total };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  async getIsrOfferRoutes(ctx) {
    const [coupons, deals] = await Promise.all([
      listIsrOfferRoutes(strapi, 'api::coupon.coupon', 'coupon'),
      listIsrOfferRoutes(strapi, 'api::deal.deal', 'deal'),
    ]);
    return ctx.send({ data: [...coupons, ...deals] });
  },

  async getCouponPage(ctx) {
    const rawId = String(ctx.params?.id ?? '').trim();
    if (!OFFER_ID_PATTERN.test(rawId)) return ctx.notFound('Coupon not found');
    const couponId = Number(rawId);
    if (!Number.isSafeInteger(couponId)) return ctx.notFound('Coupon not found');

    const couponQuery = await sanitizeDocumentQuery(
      strapi,
      ctx,
      'api::coupon.coupon',
      {
        filters: { id: couponId, ...visibilityFilters() },
        fields: COUPON_PAGE_FIELDS,
        populate: COUPON_PUBLIC_POPULATE,
        limit: 1,
      },
    );
    const coupon = (await strapi
      .documents('api::coupon.coupon')
      .findMany(couponQuery))[0];
    if (!coupon) return ctx.notFound('Coupon not found');

    const primaryEntity = couponPagePrimaryEntity(coupon);
    let relatedCoupons: any[] = [];
    let relatedDeals: any[] = [];
    let similarStores: any[] = [];

    if (primaryEntity) {
      const relatedCouponQuery = await sanitizeDocumentQuery(
        strapi,
        ctx,
        'api::coupon.coupon',
        {
          filters: {
            ...entityOfferFilters(
              primaryEntity.kind,
              primaryEntity.documentId,
              'coupon',
            ),
            documentId: { $ne: coupon.documentId },
          },
          fields: COUPON_PAGE_FIELDS,
          populate: COUPON_PUBLIC_POPULATE,
          sort: DEFAULT_OFFER_SORT,
          limit: COUPON_PAGE_RELATED_LIMIT,
        },
      );
      const relatedDealQuery = await sanitizeDocumentQuery(
        strapi,
        ctx,
        'api::deal.deal',
        {
          filters: entityOfferFilters(
            primaryEntity.kind,
            primaryEntity.documentId,
            'deal',
          ),
          fields: RELATED_DEAL_PAGE_FIELDS,
          populate: DEAL_PUBLIC_POPULATE,
          sort: DEFAULT_OFFER_SORT,
          limit: COUPON_PAGE_RELATED_DEAL_QUERY_LIMIT,
        },
      );

      [relatedCoupons, relatedDeals] = await Promise.all([
        strapi.documents('api::coupon.coupon').findMany(relatedCouponQuery),
        strapi.documents('api::deal.deal').findMany(relatedDealQuery),
      ]);

      try {
        const related = await strapi
          .service('api::store.custom' as any)
          .relatedStores(primaryEntity.kind, primaryEntity.slug, {
            limit: COUPON_PAGE_RELATED_LIMIT,
          });
        similarStores = related?.stores ?? [];
      } catch (error: any) {
        strapi.log.warn(
          `[coupon-page] related stores unavailable for ${couponId}: ${error?.message ?? error}`,
        );
      }
    }

    const [safeCoupon, safeRelatedCoupons, safeRelatedDealCandidates] = await Promise.all([
      sanitizeDocumentOutput(strapi, ctx, 'api::coupon.coupon', coupon),
      sanitizeDocumentOutput(
        strapi,
        ctx,
        'api::coupon.coupon',
        relatedCoupons,
      ),
      sanitizeDocumentOutput(strapi, ctx, 'api::deal.deal', relatedDeals),
    ]);
    const safeRelatedDeals = (Array.isArray(safeRelatedDealCandidates)
      ? safeRelatedDealCandidates
      : [])
      .filter(isRenderableCouponPageDeal)
      .slice(0, COUPON_PAGE_RELATED_DEAL_LIMIT);

    return ctx.send({
      coupon: arrayizeOfferText(safeCoupon),
      primaryEntity: couponPagePrimaryEntity(safeCoupon),
      relatedCoupons: arrayizeOfferText(safeRelatedCoupons),
      relatedDeals: arrayizeOfferText(safeRelatedDeals),
      similarStores,
    });
  },

  async getDealPage(ctx) {
    const rawId = String(ctx.params?.id ?? '').trim();
    if (!OFFER_ID_PATTERN.test(rawId)) return ctx.notFound('Deal not found');
    const dealId = Number(rawId);
    if (!Number.isSafeInteger(dealId)) return ctx.notFound('Deal not found');

    const dealQuery = await sanitizeDocumentQuery(
      strapi,
      ctx,
      'api::deal.deal',
      {
        filters: { id: dealId, ...visibilityFilters() },
        fields: DEAL_PAGE_FIELDS,
        populate: DEAL_PUBLIC_POPULATE,
        limit: 1,
      },
    );
    const deal = (await strapi.documents('api::deal.deal').findMany(dealQuery))[0];
    if (!deal) return ctx.notFound('Deal not found');

    const primaryEntity = dealPagePrimaryEntity(deal);
    let relatedDeals: any[] = [];
    let similarStores: any[] = [];

    if (primaryEntity) {
      const relatedDealQuery = await sanitizeDocumentQuery(
        strapi,
        ctx,
        'api::deal.deal',
        {
          filters: {
            ...entityOfferFilters(
              primaryEntity.kind,
              primaryEntity.documentId,
              'deal',
            ),
            documentId: { $ne: deal.documentId },
          },
          fields: DEAL_PAGE_FIELDS,
          populate: DEAL_PUBLIC_POPULATE,
          sort: DEFAULT_OFFER_SORT,
          limit: DEAL_PAGE_RELATED_QUERY_LIMIT,
        },
      );
      relatedDeals = await strapi
        .documents('api::deal.deal')
        .findMany(relatedDealQuery);

      try {
        const related = await strapi
          .service('api::store.custom' as any)
          .relatedStores(primaryEntity.kind, primaryEntity.slug, {
            limit: DEAL_PAGE_RELATED_LIMIT,
          });
        similarStores = related?.stores ?? [];
      } catch (error: any) {
        strapi.log.warn(
          `[deal-page] related stores unavailable for ${dealId}: ${error?.message ?? error}`,
        );
      }
    }

    const [safeDeal, safeRelatedCandidates] = await Promise.all([
      sanitizeDocumentOutput(strapi, ctx, 'api::deal.deal', deal),
      sanitizeDocumentOutput(strapi, ctx, 'api::deal.deal', relatedDeals),
    ]);
    const safeRelatedDeals = (Array.isArray(safeRelatedCandidates)
      ? safeRelatedCandidates
      : [])
      .filter(isRenderableCouponPageDeal)
      .slice(0, DEAL_PAGE_RELATED_LIMIT);

    return ctx.send({
      deal: arrayizeOfferText(safeDeal),
      primaryEntity: dealPagePrimaryEntity(safeDeal),
      relatedDeals: arrayizeOfferText(safeRelatedDeals),
      similarStores,
    });
  },

  async getRedeemOffer(ctx) {
    if (!isRedeemResolverAuthorized(ctx)) return ctx.unauthorized();

    const entityType = String(ctx.params?.entityType ?? '');
    const documentId = String(ctx.params?.documentId ?? '').trim();
    if (
      !(entityType in REDEEM_UIDS) ||
      !REDEEM_DOCUMENT_ID_PATTERN.test(documentId)
    ) {
      return ctx.notFound('Offer not found');
    }

    const uid = REDEEM_UIDS[entityType as keyof typeof REDEEM_UIDS];
    const commonFields = [
      'title',
      'code',
      'affiliateLink',
      'expiresAt',
      'scheduledAt',
      'contentStatus',
      'updatedAt',
    ];
    const fields = entityType === 'coupon'
      ? [...commonFields, 'couponType']
      : commonFields;
    const namedRelation = { fields: ['name'] };
    const populate = entityType === 'coupon'
      ? {
          uniqueCouponPool: { fields: ['name'] },
          stores: namedRelation,
          brands: namedRelation,
          banks: namedRelation,
        }
      : {
          primaryStore: namedRelation,
          stores: namedRelation,
          brands: namedRelation,
          banks: namedRelation,
        };

    const offer = await strapi.documents(uid as any).findOne({
      documentId,
      status: 'published',
      fields,
      populate,
    } as any);
    if (!offer) return ctx.notFound('Offer not found');

    return ctx.send({ data: offer });
  },

  async getCouponsByEntity(ctx) {
    const { slug } = ctx.params;
    const { entityType } = ctx.state;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = clampPageSize(ctx.query.pageSize, 20);

    const result = await listEntityOffers(strapi, ctx, {
      apiId: `api::${entityType}.${entityType}`,
      entityType,
      slug,
      relationField: 'coupons',
      offerUid: 'api::coupon.coupon',
      offerFields: COUPON_PUBLIC_FIELDS,
      offerPopulate: COUPON_PUBLIC_POPULATE,
      offerKind: 'coupon',
      page,
      pageSize,
    });
    if (!result) return ctx.notFound(`${entityType} not found`);

    const coupons = arrayizeOfferText(
      await sanitizeDocumentOutput(strapi, ctx, 'api::coupon.coupon', result.offers)
    );

    return ctx.send({
      [entityType]: result.sanitizedEntity,
      coupons,
      pagination: {
        page,
        pageSize,
        total: result.total,
        pageCount: Math.ceil(result.total / pageSize),
      },
    });
  },

  async getDealsByEntity(ctx) {
    const { slug } = ctx.params;
    const { entityType } = ctx.state;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = clampPageSize(ctx.query.pageSize, 20);

    const result = await listEntityOffers(strapi, ctx, {
      apiId: `api::${entityType}.${entityType}`,
      entityType,
      slug,
      relationField: 'deals',
      offerUid: 'api::deal.deal',
      offerFields: DEAL_PUBLIC_FIELDS,
      offerPopulate: DEAL_PUBLIC_POPULATE,
      offerKind: 'deal',
      page,
      pageSize,
    });
    if (!result) return ctx.notFound(`${entityType} not found`);

    const deals = arrayizeOfferText(
      await sanitizeDocumentOutput(strapi, ctx, 'api::deal.deal', result.offers)
    );

    return ctx.send({
      [entityType]: result.sanitizedEntity,
      deals,
      pagination: {
        page,
        pageSize,
        total: result.total,
        pageCount: Math.ceil(result.total / pageSize),
      },
    });
  },

  // GET /api/offers — paginated list of ALL published coupons across the site.
  async getAllOffers(ctx) {
    const result = await listPublishedOffers(
      strapi,
      ctx,
      'api::coupon.coupon',
      COUPON_PUBLIC_FIELDS,
      COUPON_PUBLIC_POPULATE,
    );
    return ctx.send(result);
  },

  // GET /api/deals — paginated list of ALL published deals across the site.
  async getAllDeals(ctx) {
    const result = await listPublishedOffers(
      strapi,
      ctx,
      'api::deal.deal',
      DEAL_PUBLIC_FIELDS,
      DEAL_PUBLIC_POPULATE,
    );
    return ctx.send(result);
  },

});
