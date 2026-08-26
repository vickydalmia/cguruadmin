import type { Core } from '@strapi/strapi';
import { toRouteSlug } from '../../../utils/route-normalization';

export const ENTITY_PAGE_TEMPLATES = [
  'default',
  'dealTemplate',
  'independenceDayTemplate',
] as const;

export type EntityPageTemplate = (typeof ENTITY_PAGE_TEMPLATES)[number];

const ENTITY_COLLECTIONS = [
  ['api::store.store', 'store'],
  ['api::brand.brand', 'brand'],
  ['api::category.category', 'category'],
  ['api::bank.bank', 'bank'],
] as const;

export type EntityTemplateOwner = {
  documentId: string;
  kind: (typeof ENTITY_COLLECTIONS)[number][1];
  slug: string;
  updatedAt?: string;
};

export async function findEntityTemplateOwners(
  strapi: Core.Strapi,
  pageTemplate: Exclude<EntityPageTemplate, 'default'>,
): Promise<EntityTemplateOwner[]> {
  const groups = await Promise.all(
    ENTITY_COLLECTIONS.map(async ([uid, kind]) => {
      const rows: any[] = await strapi.documents(uid as any).findMany({
        filters: { pageTemplate } as any,
        fields: ['documentId', 'slug', 'updatedAt'] as any,
        // Deterministic first owner: readiness `path`, route metadata and the
        // storefront's authoritative-owner check must all pick the same row.
        sort: ['slug:asc', 'documentId:asc'] as any,
      });
      return (Array.isArray(rows) ? rows : []).flatMap((row) => {
        const slug = toRouteSlug(row?.slug, kind);
        const documentId =
          typeof row?.documentId === 'string' ? row.documentId : '';
        const updatedAt =
          row?.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : typeof row?.updatedAt === 'string'
              ? row.updatedAt
              : undefined;
        return slug && documentId
          ? [{ documentId, kind, slug, ...(updatedAt ? { updatedAt } : {}) }]
          : [];
      });
    }),
  );
  return groups.flat();
}

export async function entityTemplateOwnerSlugs(
  strapi: Core.Strapi,
  pageTemplate: Exclude<EntityPageTemplate, 'default'>,
): Promise<string[]> {
  const owners = await findEntityTemplateOwners(strapi, pageTemplate);
  return [...new Set(owners.map((owner) => owner.slug))];
}

export async function withOfferTemplateOwnerSlugs(
  strapi: Core.Strapi,
  offerUid: string,
  slugs: readonly string[],
): Promise<string[]> {
  const templateSlugs = await Promise.all([
    entityTemplateOwnerSlugs(strapi, 'independenceDayTemplate'),
    offerUid === 'api::deal.deal'
      ? entityTemplateOwnerSlugs(strapi, 'dealTemplate')
      : Promise.resolve([]),
  ]);
  return [...new Set([...slugs, ...templateSlugs.flat()])];
}
