// Offer DETAIL IDENTITY: public Coupon/Product Deal detail URLs keep the
// numeric id of the default-locale row, while Strapi stores a different
// physical numeric id for every locale row of the same document. Resolve the
// stable public id to the shared documentId before loading translated content.
import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { visibilityFilters } from './offer-projections';
import { requestedOfferTargetLocale } from './public-offer-ids';

export type OfferDocumentUid =
  | 'api::coupon.coupon'
  | 'api::deal.deal';

export type OfferDetailIdentity = {
  filters: Record<string, unknown>;
  locale?: string;
};

/**
 * Build the identity portion of a public detail query.
 *
 * Default-language traffic retains the original one-query primary-key path.
 * A valid translated request performs one indexed source lookup, then returns
 * documentId + locale for the caller's content query. Unknown locales degrade
 * to English exactly like the global content-locale read middleware.
 */
export async function resolveOfferDetailIdentity(
  strapi: Core.Strapi,
  ctx: any,
  uid: OfferDocumentUid,
  publicId: number,
): Promise<OfferDetailIdentity | null> {
  const locale = requestedOfferTargetLocale(ctx);
  if (!locale) {
    return {
      filters: { id: publicId, ...visibilityFilters() },
    };
  }

  const sourceRows: any[] = await strapi.documents(uid).findMany({
    locale: DEFAULT_CONTENT_LOCALE,
    filters: { id: publicId, ...visibilityFilters() },
    fields: ['documentId'] as any,
    limit: 1,
  } as any);
  const documentId = sourceRows[0]?.documentId;
  if (typeof documentId !== 'string' || !documentId) return null;

  return {
    locale,
    filters: { documentId, ...visibilityFilters() },
  };
}
