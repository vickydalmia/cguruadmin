import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { FEATURE_REGISTRY } from '../../site-configuration/services/country-registry';
import { entityDealPageSlug } from '../../entity-deal-page/services/entity-deal-route';
import { IDENTITY_UIDS, KIND_BY_UID, isIdentityUid } from '../../../utils/identity-uids';
import { toRouteSlug } from '../../../utils/route-normalization';
import { RESERVED_ROUTE_SEGMENTS, reservedRouteSegment } from '../../../utils/reserved-route-segments';
import { normalizeRedirectPath } from '../../../utils/redirect-paths';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';
import { readSubscriptionRoute, SUBSCRIPTION_PAGE_UID, SUBSCRIPTION_SLUG_PATTERN } from './subscription-route';
import { hasConflictingRedirect } from '../../../utils/singleton-route-reservations';

export const subscriptionRedirectOwner = (documentId: string) => `subscription-page:${documentId}`;

/** Additional reciprocal URL reservation, under the existing identity lock. */
export async function validateSubscriptionRoutes(
  strapi: Core.Strapi, uid: string, data: any, documentId?: string,
  locale = DEFAULT_CONTENT_LOCALE,
) {
  if (uid !== SUBSCRIPTION_PAGE_UID && uid !== 'api::redirect.redirect' && !isIdentityUid(uid)) return;
  if (!data) return;
  if (isIdentityUid(uid) && !('slug' in data) && !('name' in data)) return;
  if (uid === 'api::redirect.redirect' && !('from' in data) && !('active' in data)) return;
  const page = await readSubscriptionRoute(strapi);
  const problems: Problem[] = [];
  if (uid === SUBSCRIPTION_PAGE_UID) {
    const slug = data.slug ?? page?.slug ?? 'subscription';
    if (documentId && page?.documentId === documentId && slug === page.slug) return;
    if (!SUBSCRIPTION_SLUG_PATTERN.test(slug ?? '')) return;
    const reserved = reservedRouteSegment(RESERVED_ROUTE_SEGMENTS, slug)
      ?? FEATURE_REGISTRY.find((feature) => feature.paths.includes(`/${slug}/`))?.label;
    if (reserved) problems.push({ path: ['slug'], message: `This URL belongs to ${reserved}. Choose a different slug.` });
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
    if (await hasConflictingRedirect(strapi, slug, subscriptionRedirectOwner(documentId ?? page?.documentId ?? ''))) {
      problems.push({ path: ['slug'], message: 'This URL is claimed by an active redirect.' });
    }
  } else if (page?.slug) {
    const stored: any = documentId ? await strapi.documents(uid as any).findOne({ documentId, locale }) : null;
    const effective = { ...stored, ...data };
    if (isIdentityUid(uid)) {
      if (toRouteSlug(effective.slug, KIND_BY_UID[uid]) === page.slug) {
        problems.push({ path: ['slug'], message: 'This URL is reserved by the Subscription Page.' });
      }
      if (entityDealPageSlug(effective.name) === page.slug) {
        problems.push({ path: ['name'], message: 'The generated Product Deal URL would collide with the Subscription Page.' });
      }
    } else if (effective.active !== false && normalizeRedirectPath(effective.from).toLowerCase() === `/${page.slug}`) {
      problems.push({ path: ['from'], message: 'This URL is reserved by the Subscription Page.' });
    }
  }
  if (problems.length) throw toValidationError(problems);
}
