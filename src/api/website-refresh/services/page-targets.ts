import { SUBSCRIPTION_PAGE_UID, readSubscriptionRoute, subscriptionPath } from '../../subscription-page/services/subscription-route';
import type { Core } from '@strapi/strapi';
import * as pages from '../../../isr-outbox/scope-static-pages';
import { ENTITY_UIDS, publicSlug } from '../../../isr-outbox/offer-relation-scopes';
import { entityTemplateOwnerSlugs } from '../../site-configuration/services/entity-template-owners';
import { TELEGRAM_PAGE_UID } from '../../../constants/telegram';
import { readTelegramRoute, telegramPath } from '../../telegram-page/services/telegram-route';

export async function pageTargets(strapi: Core.Strapi, uid: string, documentId: string): Promise<string[]> {
  if (!uid || !documentId) return [];
  if (uid === SUBSCRIPTION_PAGE_UID) {
    const page = await readSubscriptionRoute(strapi);
    const path = subscriptionPath(page);
    return page?.enabled && path ? [path] : [];
  }
  if (uid === TELEGRAM_PAGE_UID) {
    const page = await readTelegramRoute(strapi);
    const path = telegramPath(page);
    return page?.enabled && path ? [path] : [];
  }
  if (uid === 'api::homepage.homepage') return ['/'];
  const mapping = pages as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(mapping)) {
    if (key.endsWith('_UID') && value === uid) {
      const slug = mapping[key.replace(/_UID$/, '_SLUG')];
      if (typeof slug === 'string') return [`/${slug}/`];
    }
  }
  if (uid === pages.ERROR_PAGE_UID) return pages.ERROR_DOCUMENT_SLUGS.map((slug) => `/${slug}/`);
  const campaignTemplate = pages.CAMPAIGN_TEMPLATE_BY_PAGE_UID[uid];
  if (campaignTemplate) {
    return (await entityTemplateOwnerSlugs(strapi, campaignTemplate)).map((slug) => `/${slug}/`);
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
