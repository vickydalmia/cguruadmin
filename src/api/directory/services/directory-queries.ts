// Directory QUERY LOADING: the per-kind entity config and the batched
// document/offer reads. Split out of the directory service (see
// ./directory.ts).
import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import type { DirectoryKind } from './directory';

const QUERY_BATCH_SIZE = 1_000;

export type EntityConfig = {
  uid: string;
  relationField: 'stores' | 'brands' | 'categories' | 'banks';
  mediaField: 'logo' | 'icon';
  mediaAltField: 'logoAlt' | 'iconAlt';
};

export const ENTITY_CONFIG: Record<DirectoryKind, EntityConfig> = {
  store: {
    uid: 'api::store.store',
    relationField: 'stores',
    mediaField: 'logo',
    mediaAltField: 'logoAlt',
  },
  brand: {
    uid: 'api::brand.brand',
    relationField: 'brands',
    mediaField: 'logo',
    mediaAltField: 'logoAlt',
  },
  category: {
    uid: 'api::category.category',
    relationField: 'categories',
    mediaField: 'icon',
    mediaAltField: 'iconAlt',
  },
  bank: {
    uid: 'api::bank.bank',
    relationField: 'banks',
    mediaField: 'logo',
    mediaAltField: 'logoAlt',
  },
};

export async function findAllDocuments(
  strapi: Core.Strapi,
  uid: string,
  options: Record<string, any>,
): Promise<any[]> {
  const documents = strapi.documents(uid as any);
  const result: any[] = [];
  let start = 0;

  while (true) {
    const page = (await documents.findMany({
      ...options,
      start,
      limit: QUERY_BATCH_SIZE,
    } as any)) as any[];
    result.push(...page);
    if (page.length < QUERY_BATCH_SIZE) break;
    start += page.length;
  }

  return result;
}

function relationPresenceFilter(
  _kind: DirectoryKind,
  config: EntityConfig,
  _entityType: 'coupon' | 'productDeal',
) {
  // Product deals used to need an extra $or arm for the `primaryStore`
  // manyToOne. That field is gone — the store it named is carried by the
  // `stores` taxonomy — so one relation clause now covers every kind.
  return {
    [config.relationField]: { documentId: { $notNull: true } },
  };
}

export function offerQuery(
  kind: DirectoryKind,
  config: EntityConfig,
  entityType: 'coupon' | 'productDeal',
) {
  const entityRef = { fields: ['name', 'slug'] };
  const populate: Record<string, any> = {
    [config.relationField]: entityRef,
  };

  return {
    filters: {
      ...relationPresenceFilter(kind, config, entityType),
      ...publishedOnlyFilters(),
    },
    fields: ['publishedOn', 'publishedAt', 'updatedAt'],
    populate,
    sort: [
      // Editor-controlled sort key — see NEWEST_FIRST in src/utils/offer-visibility.ts.
      { publishedOn: 'desc' },
      { publishedAt: 'desc' },
      { updatedAt: 'desc' },
      { documentId: 'asc' },
    ],
  };
}
