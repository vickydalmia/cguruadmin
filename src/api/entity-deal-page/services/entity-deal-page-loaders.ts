// Entity Deal-page LOADING: populate/field projections, live-deal filters,
// entity resolution, batch reads and output sanitisation for the public
// page. One of the modules split out of the entity-deal-page service (see
// ./entity-deal-page.ts).
import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import { isActionableProductDeal } from '../../../utils/offer-visibility';
import {
  routeSlugCandidates,
  toRouteSlug,
} from '../../../utils/route-normalization';
import {
  entityDealPageSlug,
  parseEntityDealPageSlug,
} from './entity-deal-route';
import {
  DEAL_BATCH_SIZE,
  ENTITY_BATCH_SIZE,
  ENTITY_DEAL_PAGE_CONFIGS,
  ENTITY_FIELDS,
  cleanText,
  type EntityConfig,
  type ResolvedEntity,
} from './entity-deal-page-config';

export function entityPopulate(config: EntityConfig) {
  return {
    [config.mediaField]: true,
    entityDealPageSeo: { populate: { ogImage: true } },
  };
}

export function entityFields(config: EntityConfig) {
  return [...ENTITY_FIELDS, config.mediaAltField];
}

export function dealPopulate() {
  const namedLogo = {
    fields: ['name', 'slug', 'logoAlt'],
    populate: { logo: true },
  };
  return {
    dealImage: true,
    logoStore: namedLogo,
    stores: namedLogo,
    brands: namedLogo,
    banks: namedLogo,
    categories: {
      fields: ['name', 'slug', 'iconAlt'],
      populate: { icon: true },
    },
    // Name only — the pool's codes are never reachable through a content API
    // populate; they are issued one at a time by /unique-coupon/redeem.
    uniqueCouponPool: { fields: ['name'] },
  };
}

/**
 * SQL-side filter for deals eligible to appear on an entity Deal page.
 *
 * This is a deliberate SUPERSET of `isActionableProductDeal`, which stays the
 * authority over what is actually rendered. Every predicate here is a
 * necessary condition, so a deal that would be actionable can never be
 * excluded — the filter is safe to paginate against.
 *
 * The one predicate that cannot be expressed faithfully is
 * `hasSafeAffiliateLink`: it accepts root-relative paths (but not `//…`) and
 * anything `new URL()` parses as http/https, which no combination of
 * `$startsWith` reproduces without either dropping valid rows or admitting
 * `javascript:`. Write validation requires the field to be non-blank but does
 * not constrain the scheme, so a malformed link can still pass this filter and
 * be dropped in Node. That makes counts derived from this filter an UPPER
 * BOUND; `countActionableDeals` reconciles it where an exact number matters.
 */
export function liveDealFilters(
  config: EntityConfig,
  entityDocumentId?: string,
  now = new Date(),
) {
  return {
    ...publishedOnlyFilters(now),
    affiliateLink: { $notNull: true, $ne: '' },
    // A deal with no image can never be actionable, and this is exact.
    dealImage: { id: { $notNull: true } },
    ...(entityDocumentId
      ? { [config.relationField]: { documentId: entityDocumentId } }
      : { [config.relationField]: { documentId: { $notNull: true } } }),
  };
}

export async function sanitizePublicOutput(
  strapi: Core.Strapi,
  uid: string,
  data: unknown,
) {
  const schema = strapi.contentType(uid as any) as any;
  return await strapi.contentAPI.sanitize.output(data, schema, {
    auth: undefined,
  });
}


export async function findAllDocuments(
  strapi: Core.Strapi,
  uid: string,
  options: Record<string, any>,
  batchSize: number,
): Promise<any[]> {
  const rows: any[] = [];
  let start = 0;
  while (true) {
    const page: any[] = await strapi.documents(uid as any).findMany({
      ...options,
      start,
      limit: batchSize,
    } as any);
    rows.push(...page);
    if (page.length < batchSize) break;
    start += page.length;
  }
  return rows;
}

/**
 * Exact count of actionable deals, used only to settle the `no-live-deals`
 * blocker when the cheap signal is inconclusive.
 *
 * `liveDealFilters` is an upper bound (see its doc comment), so a non-zero SQL
 * count does not prove a page has anything to render. When the requested page
 * yields at least one actionable deal the answer is already known, and this
 * scan is skipped — which is every normal request. It only runs when a page
 * comes back empty despite matching rows existing, i.e. when the affiliate
 * links are malformed. Fields are kept minimal so the scan stays cheap.
 */
export async function countActionableDeals(
  strapi: Core.Strapi,
  filters: Record<string, any>,
): Promise<number> {
  const rows = await findAllDocuments(
    strapi,
    'api::deal.deal',
    {
      filters,
      fields: ['contentStatus', 'expiresAt', 'affiliateLink'],
      populate: { dealImage: { fields: ['url'] } },
      sort: [{ id: 'asc' }],
    },
    DEAL_BATCH_SIZE,
  );
  const now = new Date();
  return rows.filter((deal) => isActionableProductDeal(deal, now)).length;
}
