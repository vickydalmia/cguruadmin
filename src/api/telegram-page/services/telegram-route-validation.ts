import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { TELEGRAM_PAGE_UID, TELEGRAM_SLUG_PATTERN } from '../../../constants/telegram';
import { FEATURE_REGISTRY } from '../../site-configuration/services/country-registry';
import { entityDealPageSlug } from '../../entity-deal-page/services/entity-deal-route';
import { IDENTITY_UIDS, KIND_BY_UID, isIdentityUid } from '../../../utils/identity-uids';
import { toRouteSlug } from '../../../utils/route-normalization';
import { RESERVED_ROUTE_SEGMENTS, reservedRouteSegment } from '../../../utils/reserved-route-segments';
import { normalizeRedirectPath } from '../../../utils/redirect-paths';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';
import { readSubscriptionRoute, SUBSCRIPTION_PAGE_UID } from '../../subscription-page/services/subscription-route';
import { readTelegramRoute } from './telegram-route';
import { hasConflictingRedirect } from '../../../utils/singleton-route-reservations';

export const telegramRedirectOwner = (documentId: string) => `telegram-page:${documentId}`;

/**
 * Reciprocal URL reservation for the Join Telegram slug, under the existing
 * identity lock (mirror of validateSubscriptionRoutes). Also keeps the two
 * standalone singletons — Subscription and Telegram — from claiming the same
 * slug in either direction.
 */
export async function validateTelegramRoutes(
  strapi: Core.Strapi, uid: string, data: any, documentId?: string,
  locale = DEFAULT_CONTENT_LOCALE,
) {
  if (uid !== TELEGRAM_PAGE_UID && uid !== SUBSCRIPTION_PAGE_UID && uid !== 'api::redirect.redirect' && !isIdentityUid(uid)) return;
  if (!data) return;
  if (isIdentityUid(uid) && !('slug' in data) && !('name' in data)) return;
  if (uid === 'api::redirect.redirect' && !('from' in data) && !('active' in data)) return;
  if (uid === SUBSCRIPTION_PAGE_UID && !('slug' in data) && documentId) return;
  const page = await readTelegramRoute(strapi);
  const problems: Problem[] = [];
  if (uid === TELEGRAM_PAGE_UID) {
    const slug = data.slug ?? page?.slug ?? 'join-telegram';
    if (documentId && page?.documentId === documentId && slug === page.slug) return;
    if (!TELEGRAM_SLUG_PATTERN.test(slug ?? '')) return;
    const reserved = reservedRouteSegment(RESERVED_ROUTE_SEGMENTS, slug)
      ?? FEATURE_REGISTRY.find((feature) => feature.paths.includes(`/${slug}/`))?.label;
    if (reserved) problems.push({ path: ['slug'], message: `This URL belongs to ${reserved}. Choose a different slug.` });
    const subscription = await readSubscriptionRoute(strapi);
    if (subscription?.slug === slug) {
      problems.push({ path: ['slug'], message: 'This URL is reserved by the Subscription Page.' });
    }
    for (const target of IDENTITY_UIDS) {
      const kind = KIND_BY_UID[target];
      // Include disabled entities: they must retain their URL reservation.
      for (let start = 0; ; start += 500) {
        const rows: any[] = await strapi.documents(target).findMany({
          locale: DEFAULT_CONTENT_LOCALE, fields: ['name', 'slug'], sort: ['id:asc'] as any, start, limit: 500,
        });
        if (rows.some((row) => toRouteSlug(row.slug, kind) === slug || entityDealPageSlug(row.name) === slug)) {
          problems.push({ path: ['slug'], message: `This URL is already reserved by a ${kind} page.` });
          break;
        }
        if (rows.length < 500) break;
      }
    }
    if (await hasConflictingRedirect(strapi, slug, telegramRedirectOwner(documentId ?? page?.documentId ?? ''))) {
      problems.push({ path: ['slug'], message: 'This URL is claimed by an active redirect.' });
    }
  } else if (page?.slug) {
    if (uid === SUBSCRIPTION_PAGE_UID) {
      if ((data.slug ?? 'subscription') === page.slug) {
        problems.push({ path: ['slug'], message: 'This URL is reserved by the Telegram Page.' });
      }
    } else {
      const stored: any = documentId ? await strapi.documents(uid as any).findOne({ documentId, locale }) : null;
      const effective = { ...stored, ...data };
      if (isIdentityUid(uid)) {
        if (toRouteSlug(effective.slug, KIND_BY_UID[uid]) === page.slug) {
          problems.push({ path: ['slug'], message: 'This URL is reserved by the Telegram Page.' });
        }
        if (entityDealPageSlug(effective.name) === page.slug) {
          problems.push({ path: ['name'], message: 'The generated Product Deal URL would collide with the Telegram Page.' });
        }
      } else if (effective.active !== false && normalizeRedirectPath(effective.from).toLowerCase() === `/${page.slug}`) {
        problems.push({ path: ['from'], message: 'This URL is reserved by the Telegram Page.' });
      }
    }
  }
  if (problems.length) throw toValidationError(problems);
}
