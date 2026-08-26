import type { Core } from '@strapi/strapi';
import {
  ENTITY_CONFIG,
  findAllDocuments,
  offerQuery,
} from './directory-queries';
import {
  POPULAR_LIMIT,
  collectInventory,
  comparePopular,
  createEntityAliases,
  hydratePopular,
  mapDirectoryItems,
  type EntityInventory,
} from './directory-inventory';

// Query loading lives in ./directory-queries and inventory/ranking/media
// mapping in ./directory-inventory; this file keeps the public kind
// contract and the service surface.

export const DIRECTORY_KINDS = ['store', 'brand', 'category', 'bank'] as const;

export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];

export function isDirectoryKind(value: unknown): value is DirectoryKind {
  return DIRECTORY_KINDS.includes(value as DirectoryKind);
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getDirectory(kind: DirectoryKind) {
    const config = ENTITY_CONFIG[kind];
    const [entityDocuments, coupons, productDeals] = await Promise.all([
      findAllDocuments(strapi, config.uid, {
        fields: [
          'name',
          'slug',
          ...(config.mediaAltField ? [config.mediaAltField] : []),
        ],
        populate: {
          [config.mediaField]: {
            fields: [
              'url',
              'alternativeText',
              'width',
              'height',
              'mime',
              'ext',
              'backgroundColour',
            ],
          },
        },
        sort: [{ name: 'asc' }, { documentId: 'asc' }],
      }),
      findAllDocuments(
        strapi,
        'api::coupon.coupon',
        offerQuery(kind, config, 'coupon'),
      ),
      findAllDocuments(
        strapi,
        'api::deal.deal',
        offerQuery(kind, config, 'productDeal'),
      ),
    ]);

    const items = mapDirectoryItems(entityDocuments, config);
    const aliases = createEntityAliases(items);
    const inventory = new Map<string, EntityInventory>(
      items.map((item) => [
        item.documentId,
        {
          couponKeys: new Set<string>(),
          productDealKeys: new Set<string>(),
          latestPublication: 0,
        },
      ]),
    );
    const couponKeys = collectInventory(
      coupons,
      'coupon',
      kind,
      config,
      aliases,
      inventory,
    );
    const productDealKeys = collectInventory(
      productDeals,
      'productDeal',
      kind,
      config,
      aliases,
      inventory,
    );
    const selected = items
      .filter((item) => {
        const counts = inventory.get(item.documentId)!;
        return counts.couponKeys.size + counts.productDealKeys.size > 0;
      })
      .sort((left, right) => comparePopular(left, right, inventory))
      .slice(0, POPULAR_LIMIT);
    const popular = await hydratePopular(strapi, config, selected, inventory);
    const directoryItems = items.map((item) => {
      const counts = inventory.get(item.documentId)!;
      return {
        ...item,
        couponCount: counts.couponKeys.size,
        productDealCount: counts.productDealKeys.size,
      };
    });

    return {
      kind,
      generatedAt: new Date().toISOString(),
      totals: {
        entityCount: items.length,
        couponCount: couponKeys.size,
        productDealCount: productDealKeys.size,
      },
      popular,
      items: directoryItems,
    };
  },
});
