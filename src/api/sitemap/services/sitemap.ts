import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { cachedSiteConfiguration } from '../../site-configuration/services/cached-configuration';

// Sitemap entity feed.
//
// The frontend's route inventory (get-flat-routes.ts) already knows WHICH
// entity URLs exist; it deliberately fetches only slug/updatedAt/seo.noIndex
// because it also feeds ISR membership and must stay cheap and reliable. This
// service supplies the two extra facts a sitemap needs and nothing else:
//
//   1. `offersUpdatedAt` — the newest updatedAt among the coupons and deals
//      actually rendered on that entity page. A store page's content IS its
//      offers, so the entity row's own updatedAt under-reports badly (a store
//      whose 40 coupons all changed today still claims it last changed at
//      import). See docs/seo/sitemap-best-practices.md section 4.
//   2. `imageUrl` — the logo (store/brand/bank) or icon (category) for the
//      <image:image> entry.
//
// Membership is NOT derived from here. If this endpoint fails the sitemap
// still emits every <loc>; it just loses lastmod precision and images.

type EntityKind = 'store' | 'brand' | 'category' | 'bank';

type EntityConfig = {
  kind: EntityKind;
  uid: 'api::store.store' | 'api::brand.brand' | 'api::category.category' | 'api::bank.bank';
  /** Media attribute holding the entity's own image. Category calls it `icon`. */
  imageField: 'logo' | 'icon';
  /** Postgres table backing the collection, for the aggregate joins. */
  table: 'stores' | 'brands' | 'categories' | 'banks';
  /** Column naming this entity inside the coupons_*_lnk / deals_*_lnk tables. */
  linkColumn: 'store_id' | 'brand_id' | 'category_id' | 'bank_id';
};

const ENTITY_CONFIGS: readonly EntityConfig[] = [
  { kind: 'store', uid: 'api::store.store', imageField: 'logo', table: 'stores', linkColumn: 'store_id' },
  { kind: 'brand', uid: 'api::brand.brand', imageField: 'logo', table: 'brands', linkColumn: 'brand_id' },
  { kind: 'category', uid: 'api::category.category', imageField: 'icon', table: 'categories', linkColumn: 'category_id' },
  { kind: 'bank', uid: 'api::bank.bank', imageField: 'logo', table: 'banks', linkColumn: 'bank_id' },
];

// Same rationale as ISR_ROUTE_BATCH_SIZE in the coupon controller: ~5k entity
// rows, so a 100-row page would mean 50+ sequential Document Service calls.
const ENTITY_BATCH_SIZE = 1_000;

// The two offer collections that can contribute to an entity page's content.
// Which of them count is feature-gated per deployment: a disabled feature's
// offers never render (EntityLinkPolicy empties the sources in
// build-unified-entity-page-view.ts), so counting them here would keep pages
// in the sitemap that emit noindex. A feature-skipped source is an
// authoritative zero, NOT an incomplete aggregate.
const OFFER_SOURCES = [
  { table: 'coupons', link: (config: EntityConfig) => `coupons_${config.table}_lnk`, ownerColumn: 'coupon_id' },
  { table: 'deals', link: (config: EntityConfig) => `deals_${config.table}_lnk`, ownerColumn: 'deal_id' },
] as const;

type OfferSource = (typeof OFFER_SOURCES)[number];

async function enabledOfferSources(
  strapi: Core.Strapi,
): Promise<readonly OfferSource[]> {
  const configuration = await cachedSiteConfiguration(strapi);
  return OFFER_SOURCES.filter((source) =>
    source.table === 'coupons'
      ? configuration.couponsEnabled !== false
      : configuration.productDealsEnabled !== false,
  );
}

export type SitemapEntityRow = {
  kind: EntityKind;
  documentId: string;
  id: number;
  slug: string;
  updatedAt?: string;
  offersUpdatedAt?: string;
  imageUrl?: string;
  /**
   * Live (published, unexpired) coupons + deals rendered on this entity page.
   * Feeds the frontend thin-content guard: a zero-offer page is near-empty
   * boilerplate, so the sitemap drops it and the page emits noindex until
   * offers return. Feature-disabled sources (couponsEnabled /
   * productDealsEnabled false) contribute zero because the page renders none
   * of their offers. 0 means "confirmed empty" and is only published when
   * every ENABLED source query ran (OfferAggregateResult.complete); OMITTED
   * when any count failed, so the frontend fails open and keeps the URL.
   */
  liveOfferCount?: number;
};

function toIsoString(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// The offer aggregate is joined on afterwards; until then rows carry no count.
type SitemapEntityBaseRow = Omit<SitemapEntityRow, 'liveOfferCount'>;

async function fetchEntities(
  strapi: Core.Strapi,
  config: EntityConfig,
): Promise<SitemapEntityBaseRow[]> {
  const rows: SitemapEntityBaseRow[] = [];
  let start = 0;

  while (true) {
    const items: any[] = await strapi.documents(config.uid).findMany({
      fields: ['slug', 'updatedAt'] as any,
      populate: { [config.imageField]: { fields: ['url'] } } as any,
      sort: [{ id: 'asc' }] as any,
      start,
      limit: ENTITY_BATCH_SIZE,
    } as any);

    for (const item of items) {
      const id = Number(item?.id);
      const documentId = typeof item?.documentId === 'string' ? item.documentId : '';
      const slug = typeof item?.slug === 'string' ? item.slug : '';
      if (!Number.isSafeInteger(id) || id <= 0 || !documentId || !slug) continue;

      const imageUrl = item?.[config.imageField]?.url;

      rows.push({
        kind: config.kind,
        documentId,
        id,
        slug,
        ...(toIsoString(item?.updatedAt) ? { updatedAt: toIsoString(item.updatedAt)! } : {}),
        ...(typeof imageUrl === 'string' && imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}),
      });
    }

    if (items.length < ENTITY_BATCH_SIZE) break;
    start += items.length;
  }

  return rows;
}

/**
 * MAX(offer.updated_at) per entity, keyed by the entity's numeric id.
 *
 * Written with the knex query builder rather than raw SQL so it works on both
 * Postgres and the sqlite dev database. It is a single indexed join per link
 * table with a GROUP BY — deliberately NOT the OR-of-EXISTS shape that made
 * the search query planner inflate costs badly enough to trip JIT.
 *
 * Visibility mirrors publishedOnlyFilters(): an expired or scheduled offer is
 * not rendered on the page, so it must not move the page's lastmod.
 */
type OfferAggregate = { lastModified?: string; liveCount: number };

type OfferAggregateResult = {
  aggregates: Map<number, OfferAggregate>;
  /**
   * True only when EVERY source query ran. A zero liveOfferCount is a
   * "confirmed empty" verdict that removes the URL from the sitemap, so it may
   * only be published when both counts actually executed — a partial aggregate
   * must ship NO count (frontend fails open) rather than an authoritative 0
   * that could collapse whole sitemap shards on a transient DB fault.
   */
  complete: boolean;
};

async function fetchOfferAggregates(
  strapi: Core.Strapi,
  config: EntityConfig,
  sources: readonly OfferSource[],
): Promise<OfferAggregateResult> {
  const connection = (strapi.db as any)?.connection;
  const result = new Map<number, OfferAggregate>();
  if (typeof connection !== 'function') {
    return { aggregates: result, complete: false };
  }

  const cutoff = new Date().toISOString();
  let complete = true;

  for (const source of sources) {
    const linkTable = source.link(config);

    let rows: any[] = [];
    try {
      let query = connection(linkTable)
        .join(`${source.table} as o`, `${linkTable}.${source.ownerColumn}`, 'o.id')
        // The sitemap is built from default-locale rows (fetchEntities reads
        // the documents API, which defaults the locale); pin the aggregates
        // to the same rows so locale twins don't add spurious group rows.
        .where('o.locale', DEFAULT_CONTENT_LOCALE)
        .where('o.content_status', 'published')
        .andWhere((builder: any) =>
          builder.whereNull('o.expires_at').orWhere('o.expires_at', '>', cutoff),
        );
      if (source.table === 'deals') {
        // Deals render only inside the Trending Deals section, so an entity
        // that hides it (showTrendingDeals === false; null/absent means
        // visible, matching shouldShowEntityTrendingDeals in the frontend)
        // gets no page content from its deals — they must not keep an
        // otherwise-empty page in the sitemap.
        query = query
          .join(`${config.table} as entity`, `${linkTable}.${config.linkColumn}`, 'entity.id')
          .whereRaw('entity.show_trending_deals IS DISTINCT FROM false')
          // Card eligibility (mapProductDealCard): a deal without a usable
          // image or affiliate destination maps to no card and puts nothing
          // on the page. Residue the SQL cannot see (e.g. a non-empty link
          // with an unsafe scheme) stays covered by the page's robots tag.
          .whereRaw("btrim(coalesce(o.affiliate_link, '')) <> ''")
          .whereExists((builder: any) =>
            builder
              .select(1)
              .from('files_related_mph as mph')
              .join('files as f', 'f.id', 'mph.file_id')
              .whereRaw('mph.related_id = o.id')
              .where('mph.related_type', 'api::deal.deal')
              .where('mph.field', 'dealImage')
              .whereRaw("coalesce(f.url, '') <> ''"),
          );
        if (config.kind === 'store') {
          // Only the store rail is categorized (buildStoreTrending): a deal
          // with no category link produces no tab there. Brand/category/bank
          // rails are flat and take any card.
          query = query.whereExists((builder: any) =>
            builder
              .select(1)
              .from('deals_categories_lnk as deal_category')
              .whereRaw(`deal_category.deal_id = o.id`),
          );
        }
      }
      rows = await query
        .groupBy(`${linkTable}.${config.linkColumn}`)
        .select(`${linkTable}.${config.linkColumn} as entity_id`)
        .max('o.updated_at as last_modified')
        .count('o.id as live_count');
    } catch (error) {
      // A missing link table (fresh database, collection with no offers yet)
      // must degrade to "no aggregate" rather than fail the whole feed — but
      // it also invalidates every zero for this kind (see complete above).
      strapi.log.warn(
        `[sitemap] offer aggregate skipped for ${linkTable}: ${(error as Error)?.message}`,
      );
      complete = false;
      continue;
    }

    for (const row of rows) {
      const entityId = Number(row?.entity_id);
      if (!Number.isSafeInteger(entityId)) continue;
      const lastModified = toIsoString(row?.last_modified);
      const liveCount = Number(row?.live_count);

      const current = result.get(entityId) ?? { liveCount: 0 };
      result.set(entityId, {
        lastModified:
          lastModified && (!current.lastModified || lastModified > current.lastModified)
            ? lastModified
            : current.lastModified,
        liveCount:
          current.liveCount +
          (Number.isSafeInteger(liveCount) && liveCount > 0 ? liveCount : 0),
      });
    }
  }

  return { aggregates: result, complete };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async listSitemapEntities(): Promise<SitemapEntityRow[]> {
    const sources = await enabledOfferSources(strapi);
    const perKind = await Promise.all(
      ENTITY_CONFIGS.map(async (config) => {
        const [entities, { aggregates, complete }] = await Promise.all([
          fetchEntities(strapi, config),
          fetchOfferAggregates(strapi, config, sources),
        ]);

        return entities.map((entity) => {
          const aggregate = aggregates.get(entity.id);
          return {
            ...entity,
            ...(aggregate?.lastModified
              ? { offersUpdatedAt: aggregate.lastModified }
              : {}),
            // Only a COMPLETE aggregation may publish a count: 0 is the
            // "confirmed empty, drop from sitemap" verdict, and a partial
            // aggregate would assert it for entities whose offers were simply
            // never counted. Omission makes the frontend fail open.
            ...(complete
              ? { liveOfferCount: aggregate?.liveCount ?? 0 }
              : {}),
          };
        });
      }),
    );

    return perKind.flat();
  },
});
