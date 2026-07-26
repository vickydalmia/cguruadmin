import type { Core } from '@strapi/strapi';

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
const OFFER_SOURCES = [
  { table: 'coupons', link: (config: EntityConfig) => `coupons_${config.table}_lnk`, ownerColumn: 'coupon_id' },
  { table: 'deals', link: (config: EntityConfig) => `deals_${config.table}_lnk`, ownerColumn: 'deal_id' },
] as const;

export type SitemapEntityRow = {
  kind: EntityKind;
  documentId: string;
  id: number;
  slug: string;
  updatedAt?: string;
  offersUpdatedAt?: string;
  imageUrl?: string;
};

function toIsoString(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function fetchEntities(
  strapi: Core.Strapi,
  config: EntityConfig,
): Promise<SitemapEntityRow[]> {
  const rows: SitemapEntityRow[] = [];
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
async function fetchOfferMaxUpdatedAt(
  strapi: Core.Strapi,
  config: EntityConfig,
): Promise<Map<number, string>> {
  const connection = (strapi.db as any)?.connection;
  const result = new Map<number, string>();
  if (typeof connection !== 'function') return result;

  const cutoff = new Date().toISOString();

  for (const source of OFFER_SOURCES) {
    const linkTable = source.link(config);

    let rows: any[] = [];
    try {
      rows = await connection(linkTable)
        .join(`${source.table} as o`, `${linkTable}.${source.ownerColumn}`, 'o.id')
        .where('o.content_status', 'published')
        .andWhere((builder: any) =>
          builder.whereNull('o.expires_at').orWhere('o.expires_at', '>', cutoff),
        )
        .groupBy(`${linkTable}.${config.linkColumn}`)
        .select(`${linkTable}.${config.linkColumn} as entity_id`)
        .max('o.updated_at as last_modified');
    } catch (error) {
      // A missing link table (fresh database, collection with no offers yet)
      // must degrade to "no aggregate" rather than fail the whole feed.
      strapi.log.warn(
        `[sitemap] offer aggregate skipped for ${linkTable}: ${(error as Error)?.message}`,
      );
      continue;
    }

    for (const row of rows) {
      const entityId = Number(row?.entity_id);
      const lastModified = toIsoString(row?.last_modified);
      if (!Number.isSafeInteger(entityId) || !lastModified) continue;

      const current = result.get(entityId);
      if (!current || lastModified > current) result.set(entityId, lastModified);
    }
  }

  return result;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async listSitemapEntities(): Promise<SitemapEntityRow[]> {
    const perKind = await Promise.all(
      ENTITY_CONFIGS.map(async (config) => {
        const [entities, offerMax] = await Promise.all([
          fetchEntities(strapi, config),
          fetchOfferMaxUpdatedAt(strapi, config),
        ]);

        return entities.map((entity) => {
          const offersUpdatedAt = offerMax.get(entity.id);
          return offersUpdatedAt ? { ...entity, offersUpdatedAt } : entity;
        });
      }),
    );

    return perKind.flat();
  },
});
