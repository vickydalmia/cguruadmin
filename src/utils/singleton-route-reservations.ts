import type { Core } from '@strapi/strapi';
import { normalizeRedirectPath } from './redirect-paths';
import { findLiveEntity } from './redirect-targets';
import { readSubscriptionRoute } from '../api/subscription-page/services/subscription-route';
import { readTelegramRoute } from '../api/telegram-page/services/telegram-route';

/** Disabled aliases may have been claimed by content while the page was off. */
export async function canReactivateManagedRedirect(strapi: Core.Strapi, from: string): Promise<boolean> {
  const path = normalizeRedirectPath(from).toLowerCase();
  if (await findLiveEntity(strapi, path)) return false;
  const [subscription, telegram] = await Promise.all([readSubscriptionRoute(strapi), readTelegramRoute(strapi)]);
  return ![subscription, telegram].some(page => page?.slug && path === `/${page.slug}`);
}

/** Called under the identity lock. Never truncate the reservation inventory. */
export async function hasConflictingRedirect(strapi: Core.Strapi, slug: string, owner: string): Promise<boolean> {
  for (let start = 0; ; start += 500) {
    const rows: any[] = await strapi.documents('api::redirect.redirect').findMany({
      filters: { active: true }, fields: ['from', 'managedBy'] as any,
      sort: ['id:asc'] as any, start, limit: 500,
    });
    if (rows.some(row => normalizeRedirectPath(row.from).toLowerCase() === `/${slug}` && row.managedBy !== owner)) return true;
    if (rows.length < 500) return false;
  }
}
