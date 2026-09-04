import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import { publishedOnlyFilters } from '../../../utils/content-status';
import {
  isActionableProductDeal,
  NEWEST_FIRST,
} from '../../../utils/offer-visibility';
import { parseEntityDealPageSlug } from './entity-deal-route';
import {
  DEAL_FIELDS,
  ENTITY_DEAL_PAGE_CONFIGS,
  configForKind,
  cleanText,
  normalizePage,
  normalizePageSize,
  type SeoInput,
} from './entity-deal-page-config';
import {
  countActionableDeals,
  dealPopulate,
  liveDealFilters,
  sanitizePublicOutput,
} from './entity-deal-page-loaders';
import {
  hasRouteConflict,
  resolveEntityByDealSlug,
} from './entity-deal-page-route-owners';
import {
  normalizeSeoPatch,
  resolveEntityDealPageSeo,
  seoPatchChanges,
} from './entity-deal-page-seo';
import {
  DEFAULT_SETTINGS_SORT,
  SETTINGS_SORT_FIELDS,
  loadSettingItems,
  parseSettingsSort,
  publicEntityDealPageRoute,
  settingsComparator,
  type SettingsSort,
} from './entity-deal-page-settings';

// The thin entity-deal-page service: configuration/projections live in
// ./entity-deal-page-config, SEO resolution and patch validation in
// ./entity-deal-page-seo, public-page loading in ./entity-deal-page-loaders,
// generated-route ownership/conflicts in ./entity-deal-page-route-owners,
// and the settings inventory/sorting in ./entity-deal-page-settings.

export {
  entityDealPagePath,
  entityDealPageSlug,
  parseEntityDealPageSlug,
} from './entity-deal-route';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getPublicPage(rawDealSlug: unknown, rawQuery: Record<string, unknown> = {}) {
    const nameSlug = parseEntityDealPageSlug(rawDealSlug);
    if (!nameSlug) return null;
    const requestedDealSlug = `${nameSlug}-deals`;

    const locale = cleanText(rawQuery.locale) ?? 'en';
    const resolved = await resolveEntityByDealSlug(
      strapi,
      requestedDealSlug,
      locale,
    );
    if (!resolved) return null;

    const page = normalizePage(rawQuery.page);
    const pageSize = normalizePageSize(rawQuery.pageSize);
    const filters = liveDealFilters(
      resolved.config,
      resolved.entity.documentId,
    );

    // Pagination happens in the database. This used to load every deal for the
    // entity with a five-way populate and then slice in memory, so `?pageSize=1`
    // cost the same as the full catalogue — and Astro requests every page of it.
    const start = (page - 1) * pageSize;
    const [rawDeals, matchedTotal, routeConflict] = await Promise.all([
      strapi.documents('api::deal.deal' as any).findMany({
        locale,
        filters: filters as any,
        fields: DEAL_FIELDS as any,
        populate: dealPopulate() as any,
        sort: NEWEST_FIRST as any,
        start,
        limit: pageSize,
      } as any),
      strapi.documents('api::deal.deal' as any).count({
        locale,
        filters: filters as any,
      } as any),
      hasRouteConflict(strapi, resolved),
    ]);

    const now = new Date();
    const pagedDeals = (Array.isArray(rawDeals) ? rawDeals : []).filter(
      (deal) => isActionableProductDeal(deal, now),
    );

    // `matchedTotal` counts the SQL superset. It is exact unless a deal has a
    // malformed affiliate link, which only the Node predicate can detect. The
    // count is used for the `no-live-deals` blocker, so settle it exactly when
    // — and only when — the cheap signal cannot: a page that returned nothing
    // actionable while the superset says rows exist.
    const supersetTotal = typeof matchedTotal === 'number' ? matchedTotal : 0;
    const total = pagedDeals.length === 0 && supersetTotal > 0
      ? await countActionableDeals(strapi, filters, locale)
      : supersetTotal;

    const [entity, deals] = await Promise.all([
      sanitizePublicOutput(strapi, resolved.config.uid, resolved.entity),
      sanitizePublicOutput(strapi, 'api::deal.deal', pagedDeals),
    ]);
    const resolvedSeo = resolveEntityDealPageSeo({
      entity,
      publicSlug: resolved.publicSlug,
      dealSlug: resolved.dealSlug,
      liveDealCount: total,
      routeConflict,
    });

    const decoratedDeals = arrayizeOfferText(deals);
    await attachFestiveOffers(strapi, decoratedDeals);

    return {
      data: {
        route: {
          entityType: resolved.config.kind,
          documentId: resolved.entity.documentId,
          sourceSlug: resolved.entity.slug,
          publicSlug: resolved.publicSlug,
          entityPath: `/${resolved.publicSlug}/`,
          permalink: `/${resolved.dealSlug}/`,
        },
        entity,
        seo: resolvedSeo,
        deals: decoratedDeals,
        pagination: {
          page,
          pageSize,
          total,
          pageCount: Math.ceil(total / pageSize),
        },
      },
    };
  },

  async listSettings(rawQuery: Record<string, unknown> = {}) {
    const requestedKind = cleanText(rawQuery.kind);
    const requestedState = cleanText(rawQuery.indexState);
    const search = cleanText(rawQuery.search)?.toLowerCase() ?? null;
    const page = normalizePage(rawQuery.page);
    const pageSize = normalizePageSize(rawQuery.pageSize);
    const sort = parseSettingsSort(rawQuery.sort);
    const configs = requestedKind
      ? ENTITY_DEAL_PAGE_CONFIGS.filter((config) => config.kind === requestedKind)
      : ENTITY_DEAL_PAGE_CONFIGS;

    if (requestedKind && configs.length === 0) {
      throw new errors.ValidationError(
        'kind must be store, brand, category, or bank.',
      );
    }
    if (
      requestedState
      && !['enabled', 'disabled', 'blocked'].includes(requestedState)
    ) {
      throw new errors.ValidationError(
        'indexState must be enabled, disabled, or blocked.',
      );
    }

    let items = await loadSettingItems(strapi, configs);

    if (search) {
      items = items.filter((item) =>
        [item.name, item.sourceSlug, item.permalink].some((value) =>
          String(value ?? '').toLowerCase().includes(search),
        ),
      );
    }
    if (requestedState) {
      items = items.filter((item) => item.indexState === requestedState);
    }
    items.sort(settingsComparator(sort));

    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
      data: items.slice(start, start + pageSize),
      meta: {
        pagination: {
          page,
          pageSize,
          total,
          pageCount: Math.ceil(total / pageSize),
        },
      },
    };
  },

  async listPublicRoutes(locale = 'en') {
    const allItems = await loadSettingItems(
      strapi,
      ENTITY_DEAL_PAGE_CONFIGS,
      locale,
    );
    // A generated Deal page with nothing to render is not a route. Emitting one
    // per entity regardless of liveDealCount doubled the site's route surface
    // with pages that render empty, and put them in the sitemap.
    const items = allItems.filter((item) => item.liveDealCount > 0);
    items.sort(
      (left, right) =>
        left.entityType.localeCompare(right.entityType)
        || (left.id ?? Number.MAX_SAFE_INTEGER)
          - (right.id ?? Number.MAX_SAFE_INTEGER)
        || left.documentId.localeCompare(right.documentId),
    );
    return {
      // `documentId` is deliberately NOT published here: this route is
      // anonymous, and documentId is the path parameter the Super-Admin PATCH
      // endpoint takes. `id` stays — the frontend assigns sitemap shards from
      // it (features/routing/services/route-inventory.ts).
      data: items.map(publicEntityDealPageRoute),
    };
  },

  async updateSettings(
    rawKind: unknown,
    rawDocumentId: unknown,
    rawPatch: unknown,
  ) {
    const config = configForKind(rawKind);
    const documentId = cleanText(rawDocumentId);
    if (!config || !documentId) return null;

    const current: any = await strapi.documents(config.uid).findOne({
      documentId,
      fields: ['documentId'] as any,
      populate: {
        entityDealPageSeo: { populate: { ogImage: true } },
      } as any,
    } as any);
    if (!current) return null;

    const patch =
      rawPatch
      && typeof rawPatch === 'object'
      && Object.prototype.hasOwnProperty.call(rawPatch, 'entityDealPageSeo')
        ? Reflect.get(rawPatch, 'entityDealPageSeo')
        : rawPatch;
    const entityDealPageSeo = normalizeSeoPatch(
      current.entityDealPageSeo,
      patch,
    );

    // Skip the write when nothing actually changed. An entity write goes
    // through the ISR outbox, and a no-op PATCH — which the settings screen
    // will produce every time an editor opens a row and saves without editing
    // — otherwise costs a page rebuild.
    if (!seoPatchChanges(current.entityDealPageSeo, entityDealPageSeo)) {
      return {
        data: {
          entityType: config.kind,
          documentId,
          entityDealPageSeo,
        },
      };
    }

    await strapi.documents(config.uid).update({
      documentId,
      data: { entityDealPageSeo } as any,
    });

    return {
      data: {
        entityType: config.kind,
        documentId,
        entityDealPageSeo,
      },
    };
  },
});
