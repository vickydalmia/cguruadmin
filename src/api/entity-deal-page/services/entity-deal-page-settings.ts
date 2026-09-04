// Entity Deal-page SETTINGS INVENTORY: the admin settings-screen items,
// their sort contract and the public-route mapping. One of the modules
// split out of the entity-deal-page service (see ./entity-deal-page.ts).
import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import { isActionableProductDeal } from '../../../utils/offer-visibility';
import { toRouteSlug } from '../../../utils/route-normalization';
import { entityDealPagePath, entityDealPageSlug } from './entity-deal-route';
import {
  DEAL_BATCH_SIZE,
  DEAL_FIELDS,
  ENTITY_BATCH_SIZE,
  ENTITY_DEAL_PAGE_CONFIGS,
  SEO_FIELDS,
  cleanText,
  collapseText,
  type EntityConfig,
  type EntityDealPageIndexBlocker,
  type SeoInput,
} from './entity-deal-page-config';
import {
  countActionableDeals,
  entityFields,
  entityPopulate,
  findAllDocuments,
} from './entity-deal-page-loaders';
import {
  entityRouteOwners,
  hasRouteConflict,
  normalizeRedirectFrom,
  routeConflictFor,
} from './entity-deal-page-route-owners';
import { resolveEntityDealPageSeo } from './entity-deal-page-seo';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';

export function mapSettingItem(input: {
  config: EntityConfig;
  entity: any;
  publicSlug: string;
  dealSlug: string;
  liveDealCount: number;
  liveDealUpdatedAt?: string;
  routeConflict: boolean;
}) {
  const resolvedSeo = resolveEntityDealPageSeo(input);
  const entityUpdatedAt = cleanText(input.entity.updatedAt);
  const updatedAt =
    [entityUpdatedAt, input.liveDealUpdatedAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? undefined;
  return {
    entityType: input.config.kind,
    documentId: input.entity.documentId,
    id: input.entity.id,
    name: collapseText(input.entity.name) ?? input.publicSlug,
    sourceSlug: input.entity.slug,
    publicSlug: input.publicSlug,
    entityPath: `/${input.publicSlug}/`,
    permalink: `/${input.dealSlug}/`,
    liveDealCount: input.liveDealCount,
    updatedAt,
    entityDealPageSeo: input.entity.entityDealPageSeo ?? null,
    resolvedSeo,
    indexState: !resolvedSeo.indexingEnabled
      ? 'disabled' as const
      : resolvedSeo.effectiveIndexable
        ? 'enabled' as const
        : 'blocked' as const,
  };
}

export function publicEntityDealPageRoute(item: {
  entityType: string;
  id?: number;
  permalink: string;
  updatedAt?: string;
  resolvedSeo: {
    noIndex: boolean;
    blockers: readonly EntityDealPageIndexBlocker[];
  };
}) {
  return {
    entityType: item.entityType,
    id: item.id,
    path: item.permalink,
    updatedAt: item.updatedAt,
    noIndex: item.resolvedSeo.noIndex,
    // A redirect-owned path is not merely non-indexable: it must be absent
    // from live route membership so the gateway can resolve the authored
    // redirect instead of a generated page.
    routeConflict: item.resolvedSeo.blockers.includes('route-conflict'),
  };
}

export const SETTINGS_SORT_FIELDS = [
  'name',
  'liveDealCount',
  'updatedAt',
] as const;

export type SettingsSortField = (typeof SETTINGS_SORT_FIELDS)[number];

export type SettingsSort = { field: SettingsSortField; desc: boolean };

export const DEFAULT_SETTINGS_SORT: SettingsSort = { field: 'name', desc: false };

/**
 * Parse `?sort=liveDealCount:desc` into a sort descriptor.
 *
 * Sorting has to happen here rather than in the admin table: listSettings
 * paginates AFTER sorting, so a client-side sort would only reorder the 25
 * rows of the current page and silently lie about which entities have the most
 * Deals. An unrecognised field or direction falls back to the default instead
 * of erroring — a bad sort is a broken control, not a broken request.
 */
export function parseSettingsSort(raw: unknown): SettingsSort {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_SETTINGS_SORT;

  const [rawField, rawDirection] = value.split(':');
  const field = SETTINGS_SORT_FIELDS.find((candidate) => candidate === rawField);
  if (!field) return DEFAULT_SETTINGS_SORT;

  return { field, desc: rawDirection?.toLowerCase() === 'desc' };
}

type SortableItem = {
  name: string;
  entityType: string;
  documentId: string;
  liveDealCount: number;
  updatedAt?: string;
};

/**
 * Every comparator ends in the same name/type/documentId tiebreak, so equal
 * primary values keep a stable, deterministic order. Without it, offset
 * pagination over ties (very common: hundreds of entities share
 * liveDealCount 0) could show the same row on two pages and drop another.
 */
export function settingsComparator(
  sort: SettingsSort,
): (left: SortableItem, right: SortableItem) => number {
  const direction = sort.desc ? -1 : 1;
  const byIdentity = (left: SortableItem, right: SortableItem) =>
    left.name.localeCompare(right.name, 'en', { sensitivity: 'base' })
    || left.entityType.localeCompare(right.entityType)
    || left.documentId.localeCompare(right.documentId);
  const timestamp = (item: SortableItem): number | null => {
    if (!item.updatedAt) return null;
    const value = Date.parse(item.updatedAt);
    return Number.isNaN(value) ? null : value;
  };

  return (left, right) => {
    let primary = 0;
    if (sort.field === 'liveDealCount') {
      primary = left.liveDealCount - right.liveDealCount;
    } else if (sort.field === 'updatedAt') {
      // Missing or invalid timestamps stay last in both directions. Applying
      // the normal direction multiplier to a sentinel would move them to the
      // front for one direction.
      const leftTimestamp = timestamp(left);
      const rightTimestamp = timestamp(right);
      if (leftTimestamp === null || rightTimestamp === null) {
        if (leftTimestamp === rightTimestamp) return byIdentity(left, right);
        return leftTimestamp === null ? 1 : -1;
      }
      primary = leftTimestamp - rightTimestamp;
    } else {
      primary = left.name.localeCompare(right.name, 'en', {
        sensitivity: 'base',
      });
    }

    return primary !== 0 ? primary * direction : byIdentity(left, right);
  };
}

export async function loadSettingItems(
  strapi: Core.Strapi,
  configs: readonly EntityConfig[],
  locale = DEFAULT_CONTENT_LOCALE,
) {
  const [perConfigEntities, activeRedirects] = await Promise.all([
    Promise.all(
      configs.map(async (config) => {
        const entities = await findAllDocuments(
          strapi,
          config.uid,
          {
            locale,
            fields: entityFields(config) as any,
            populate: entityPopulate(config) as any,
            sort: [{ id: 'asc' }],
          },
          ENTITY_BATCH_SIZE,
        );
        const sourceRows = locale === DEFAULT_CONTENT_LOCALE
          ? entities
          : entities.length > 0
            ? await findAllDocuments(
              strapi,
              config.uid,
              {
                locale: DEFAULT_CONTENT_LOCALE,
                filters: {
                  documentId: {
                    $in: entities.map((entity) => entity.documentId),
                  },
                },
                fields: ['documentId', 'name'],
                sort: [{ id: 'asc' }],
              },
              ENTITY_BATCH_SIZE,
            )
            : [];
        return {
          config,
          entities,
          routeNameByDocumentId: new Map(
            sourceRows.map((entity) => [entity.documentId, entity.name]),
          ),
        };
      }),
    ),
    // Paged, not `limit: 2_000` — past a flat cap the route-conflict blocker
    // silently stops firing for every redirect beyond the window.
    findAllDocuments(
      strapi,
      'api::redirect.redirect',
      {
        filters: { active: true },
        fields: ['from'],
        sort: [{ id: 'asc' }],
      },
      ENTITY_BATCH_SIZE,
    ),
  ]);

  const allEntityRows = perConfigEntities.flatMap(({
    config,
    entities,
    routeNameByDocumentId,
  }) =>
    entities.flatMap((entity) => {
      const publicSlug = toRouteSlug(entity?.slug, config.kind);
      const dealSlug = entityDealPageSlug(
        routeNameByDocumentId.get(entity?.documentId),
      );
      return publicSlug && dealSlug
        ? [{ config, entity, publicSlug, dealSlug }]
        : [];
    }),
  );
  const publicEntitySlugs = new Set(
    allEntityRows.map((row) => row.publicSlug),
  );
  const dealSlugCounts = new Map<string, number>();
  for (const row of allEntityRows) {
    dealSlugCounts.set(row.dealSlug, (dealSlugCounts.get(row.dealSlug) ?? 0) + 1);
  }
  const redirectPaths = new Set(
    (Array.isArray(activeRedirects) ? activeRedirects : [])
      .map((row: any) => normalizeRedirectFrom(row?.from))
      .filter((value): value is string => Boolean(value)),
  );

  // ONE scan over the deal table, not one per entity type. The four scans this
  // replaces differed only in which relation they populated, so a deal linked
  // to a store, a brand and a category was fetched and materialised three
  // times. `sort` is required: findAllDocuments pages by offset, and offsetting
  // through an unordered result set can repeat or skip rows across the batch
  // boundary — which would corrupt liveDealCount and the no-live-deals blocker.
  const { contentStatus, $and: publishedAnd } = publishedOnlyFilters();
  const deals = await findAllDocuments(
    strapi,
    'api::deal.deal',
    {
      locale,
      filters: {
        contentStatus,
        $and: publishedAnd,
        affiliateLink: { $notNull: true, $ne: '' },
        dealImage: { id: { $notNull: true } },
        $or: configs.map((config) => ({
          [config.relationField]: { documentId: { $notNull: true } },
        })),
      },
      fields: DEAL_FIELDS as any,
      populate: {
        dealImage: true,
        ...Object.fromEntries(
          configs.map((config) => [
            config.relationField,
            { fields: ['documentId'] },
          ]),
        ),
      },
      sort: [{ id: 'asc' }],
    },
    DEAL_BATCH_SIZE,
  );

  const liveDealMeta = new Map<
    string,
    { count: number; updatedAt?: string }
  >();
  const now = new Date();
  for (const deal of deals) {
    if (!isActionableProductDeal(deal, now)) continue;
    const dealUpdatedAt = cleanText(deal?.updatedAt) ?? undefined;
    for (const config of configs) {
      const seen = new Set<string>();
      for (const entity of deal?.[config.relationField] ?? []) {
        const documentId = cleanText(entity?.documentId);
        if (!documentId || seen.has(documentId)) continue;
        seen.add(documentId);
        const current = liveDealMeta.get(documentId);
        liveDealMeta.set(documentId, {
          count: (current?.count ?? 0) + 1,
          updatedAt:
            [current?.updatedAt, dealUpdatedAt]
              .filter((value): value is string => Boolean(value))
              .sort()
              .at(-1) ?? undefined,
        });
      }
    }
  }

  return allEntityRows.map(({ config, entity, publicSlug, dealSlug }) => {
    const meta = liveDealMeta.get(entity.documentId);
    return mapSettingItem({
      config,
      entity,
      publicSlug,
      dealSlug,
      liveDealCount: meta?.count ?? 0,
      liveDealUpdatedAt: meta?.updatedAt,
      routeConflict: routeConflictFor(
        dealSlug,
        publicEntitySlugs,
        dealSlugCounts,
        redirectPaths,
      ),
    });
  });
}
