import type { Core } from '@strapi/strapi';
import type { ScopeRequest } from '../../../isr-outbox/types';
import { normalizeRedirectPath } from '../../../utils/redirect-paths';
import { subscriptionPath, type SubscriptionRouteState } from './subscription-route';
import { subscriptionRedirectOwner } from './subscription-route-validation';
import { canReactivateManagedRedirect } from '../../../utils/singleton-route-reservations';

/** Called inside the page's content transaction; document writes join it. */
export async function syncSubscriptionRedirects(
  strapi: Core.Strapi,
  before: SubscriptionRouteState | null,
  after: SubscriptionRouteState | null,
) {
  const documentId = after?.documentId ?? before?.documentId;
  if (!documentId) return;
  const oldPath = subscriptionPath(before);
  const newPath = subscriptionPath(after);
  if (oldPath === newPath && before?.enabled === after?.enabled) return;
  const managedBy = subscriptionRedirectOwner(documentId);
  const redirects = strapi.documents('api::redirect.redirect');
  const owned: any[] = await redirects.findMany({ filters: { managedBy } as any, limit: 2000 });
  // Deactivate a previous alias before targeting it on a rename-back, avoiding
  // transient redirect cycles in the normal redirect validator.
  for (const row of owned) {
    if (!after?.enabled || !newPath || normalizeRedirectPath(row.from) === normalizeRedirectPath(newPath)) {
      await redirects.update({ documentId: row.documentId, data: { active: false } });
    }
  }
  if (!after?.enabled || !newPath) return;
  for (const row of owned) {
    if (normalizeRedirectPath(row.from) !== normalizeRedirectPath(newPath)) {
      if (row.active === false && !await canReactivateManagedRedirect(strapi, row.from)) continue;
      await redirects.update({ documentId: row.documentId, data: { to: newPath, statusCode: 301, active: true } });
    }
  }
  if (before?.enabled && oldPath && oldPath !== newPath && !owned.some((row) => normalizeRedirectPath(row.from) === normalizeRedirectPath(oldPath))) {
    await redirects.create({ data: { from: oldPath, to: newPath, statusCode: 301, active: true, managedBy } as any });
  }
}

export function subscriptionWriteScope(before: SubscriptionRouteState | null, after: SubscriptionRouteState | null): ScopeRequest {
  const current = after?.enabled ? after.slug : null;
  const retired = before?.slug && before.slug !== current ? before.slug : null;
  return {
    slugs: current ? [current] : [],
    // A disabled/deleted/renamed URL is intentionally absent after refresh.
    optionalSlugs: retired ? [retired] : [],
    sitemap: true,
    refreshScopes: ['routes'],
  };
}
