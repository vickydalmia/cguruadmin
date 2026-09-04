import type { Core } from '@strapi/strapi';
import { resolveEntityLastUpdate } from '../services/entity-last-update';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import { listIsrOfferRoutes } from '../services/isr-offer-routes';
import {
  COUPON_PUBLIC_FIELDS,
  COUPON_PUBLIC_POPULATE,
  DEAL_PUBLIC_FIELDS,
  DEAL_PUBLIC_POPULATE,
  DEFAULT_OFFER_SORT,
  clampPageSize,
  visibilityFilters,
} from '../services/offer-projections';
import {
  COUPON_PAGE_FIELDS,
  COUPON_PAGE_RELATED_DEAL_LIMIT,
  COUPON_PAGE_RELATED_DEAL_QUERY_LIMIT,
  COUPON_PAGE_RELATED_LIMIT,
  DEAL_PAGE_FIELDS,
  DEAL_PAGE_RELATED_LIMIT,
  DEAL_PAGE_RELATED_QUERY_LIMIT,
  OFFER_ID_PATTERN,
  RELATED_DEAL_PAGE_FIELDS,
  couponPagePrimaryEntity,
  dealPagePrimaryEntity,
  isRenderableCouponPageDeal,
} from '../services/offer-page-builders';
import {
  entityOfferFilters,
  listEntityOffers,
  listPublishedOffers,
} from '../services/offer-entity-listings';
import {
  redactUniqueOfferCode,
  sanitizeDocumentOutput,
  sanitizeDocumentQuery,
} from '../services/offer-sanitizers';
import {
  REDEEM_DOCUMENT_ID_PATTERN,
  REDEEM_UIDS,
  isRedeemResolverAuthorized,
} from '../services/redeem-resolution';
import { resolveOfferDetailIdentity } from '../services/offer-detail-resolution';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import {
  attachStablePublicOfferIdsForRequest,
  requestedOfferTargetLocale,
} from '../services/public-offer-ids';

// The thin coupon controller action map: projections live in
// ../services/offer-projections, detail-page builders in
// ../services/offer-page-builders, entity listings in
// ../services/offer-entity-listings, the sanitizer boundary in
// ../services/offer-sanitizers, ISR route inventory in
// ../services/isr-offer-routes, and redeem resolution in
// ../services/redeem-resolution.

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  async getIsrOfferRoutes(ctx) {
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const [coupons, deals] = await Promise.all([
      listIsrOfferRoutes(strapi, 'api::coupon.coupon', 'coupon', locale),
      listIsrOfferRoutes(strapi, 'api::deal.deal', 'deal', locale),
    ]);
    return ctx.send({ data: [...coupons, ...deals] });
  },

  async getCouponPage(ctx) {
    const rawId = String(ctx.params?.id ?? '').trim();
    if (!OFFER_ID_PATTERN.test(rawId)) return ctx.notFound('Coupon not found');
    const couponId = Number(rawId);
    if (!Number.isSafeInteger(couponId)) return ctx.notFound('Coupon not found');

    const detailIdentity = await resolveOfferDetailIdentity(
      strapi,
      ctx,
      'api::coupon.coupon',
      couponId,
    );
    if (!detailIdentity) return ctx.notFound('Coupon not found');

    const couponQuery = await sanitizeDocumentQuery(
      strapi,
      ctx,
      'api::coupon.coupon',
      {
        ...detailIdentity,
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

    const body = {
      coupon: arrayizeOfferText(safeCoupon),
      primaryEntity: couponPagePrimaryEntity(safeCoupon),
      relatedCoupons: arrayizeOfferText(safeRelatedCoupons),
      relatedDeals: arrayizeOfferText(safeRelatedDeals),
      similarStores,
    };
    // One pass over the whole body: the main coupon, its related coupons and
    // its related deals are all offers and all need their merchant resolved.
    await attachFestiveOffers(strapi, body);
    await attachStablePublicOfferIdsForRequest(strapi, ctx, body);

    return ctx.send(body);
  },

  async getDealPage(ctx) {
    const rawId = String(ctx.params?.id ?? '').trim();
    if (!OFFER_ID_PATTERN.test(rawId)) return ctx.notFound('Deal not found');
    const dealId = Number(rawId);
    if (!Number.isSafeInteger(dealId)) return ctx.notFound('Deal not found');

    const detailIdentity = await resolveOfferDetailIdentity(
      strapi,
      ctx,
      'api::deal.deal',
      dealId,
    );
    if (!detailIdentity) return ctx.notFound('Deal not found');

    const dealQuery = await sanitizeDocumentQuery(
      strapi,
      ctx,
      'api::deal.deal',
      {
        ...detailIdentity,
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

    const body = {
      deal: arrayizeOfferText(safeDeal),
      primaryEntity: dealPagePrimaryEntity(safeDeal),
      relatedDeals: arrayizeOfferText(safeRelatedDeals),
      similarStores,
    };
    await attachFestiveOffers(strapi, body);
    await attachStablePublicOfferIdsForRequest(strapi, ctx, body, ['deal']);

    return ctx.send(body);
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
    // Both offer types can draw from a pool now, so neither branch is
    // entity-specific any more.
    const fields = [...commonFields, 'couponType'];
    const namedRelation = { fields: ['name'] };
    const populate = {
      uniqueCouponPool: { fields: ['name'] },
      stores: namedRelation,
      brands: namedRelation,
      banks: namedRelation,
    };

    const offer = await strapi.documents(uid as any).findOne({
      documentId,
      // Redemption data is shared machine state (code, pool and affiliate
      // URL). Pin its resolver to the route-owning English row so a caller's
      // `?locale=` can never change which code or destination is activated.
      locale: DEFAULT_CONTENT_LOCALE,
      status: 'published',
      fields,
      populate,
    } as any);
    if (!offer) return ctx.notFound('Offer not found');

    // This route bypasses the sanitizers above, so apply the same redaction —
    // the gateway refuses to expose a unique offer's `code` too, but neither
    // side should be the only thing standing between a legacy row and the wire.
    return ctx.send({ data: redactUniqueOfferCode(offer) });
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
    await attachFestiveOffers(strapi, coupons);

    const body = {
      ...(page === 1 ? { [entityType]: result.sanitizedEntity } : {}),
      coupons,
      pagination: {
        page,
        pageSize,
        total: result.total,
        pageCount: Math.ceil(result.total / pageSize),
      },
    };
    await attachStablePublicOfferIdsForRequest(strapi, ctx, body, ['coupon']);
    return ctx.send(body);
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
    await attachFestiveOffers(strapi, deals);

    const body = {
      ...(page === 1 ? { [entityType]: result.sanitizedEntity } : {}),
      deals,
      pagination: {
        page,
        pageSize,
        total: result.total,
        pageCount: Math.ceil(result.total / pageSize),
      },
    };
    await attachStablePublicOfferIdsForRequest(strapi, ctx, body, ['deal']);
    return ctx.send(body);
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
