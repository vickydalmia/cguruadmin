import type { Core } from '@strapi/strapi';
import * as pages from '../../../isr-outbox/scope-static-pages';
import { ENTITY_UIDS, publicSlug } from '../../../isr-outbox/offer-relation-scopes';
import { entityTemplateOwnerSlugs } from '../../site-configuration/services/entity-template-owners';

export async function pageTargets(strapi: Core.Strapi, uid: string, documentId: string): Promise<string[]> {
  if (!uid || !documentId) return [];
  if (uid === 'api::homepage.homepage') return ['/'];
  const mapping = pages as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(mapping)) {
    if (key.endsWith('_UID') && value === uid) {
      const slug = mapping[key.replace(/_UID$/, '_SLUG')];
      if (typeof slug === 'string') return [`/${slug}/`];
    }
  }
  if (uid === pages.ERROR_PAGE_UID) return pages.ERROR_DOCUMENT_SLUGS.map((slug) => `/${slug}/`);
  if (uid === pages.DOTD_PAGE_UID || uid === pages.INDEPENDENCE_DAY_SALE_PAGE_UID) {
    return (await entityTemplateOwnerSlugs(strapi, uid === pages.DOTD_PAGE_UID ? 'dealTemplate' : 'independenceDayTemplate')).map((slug) => `/${slug}/`);
  }
  const kind = ENTITY_UIDS[uid];
  const offer = uid === 'api::coupon.coupon' ? 'coupon' : uid === 'api::deal.deal' ? 'deal' : null;
  if (!kind && !offer && uid !== pages.JOB_UID) return [];
  const doc: any = await strapi.documents(uid as any).findOne({
    documentId, locale: 'en', status: 'published',
    fields: (offer ? ['documentId'] : kind ? ['slug', 'name'] : ['slug']) as any,
  });
  if (!doc) return [];
  if (offer) return Number.isSafeInteger(doc.id) ? [`/${offer}/${doc.id}/`] : [];
  if (uid === pages.JOB_UID) return doc.slug ? [`/careers/${doc.slug}/`] : [];
  const slug = publicSlug(doc.slug, kind);
  return slug ? [`/${slug}/`] : [];
}
