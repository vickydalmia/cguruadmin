import type { Core } from '@strapi/strapi';
import type { ScopeRequest } from '../../../isr-outbox/types';
import { normalizeRedirectPath } from '../../../utils/redirect-paths';
import { telegramPath, type TelegramRouteState } from './telegram-route';
import { telegramRedirectOwner } from './telegram-route-validation';
import { canReactivateManagedRedirect } from '../../../utils/singleton-route-reservations';

/**
 * Called inside the page's content transaction; document writes join it.
 * A slug change leaves a permanent redirect from the old URL; disabling the
 * page retires its redirects. Mirror of syncSubscriptionRedirects.
 */
export async function syncTelegramRedirects(
  strapi: Core.Strapi,
  before: TelegramRouteState | null,
  after: TelegramRouteState | null,
) {
  const documentId = after?.documentId ?? before?.documentId;
  if (!documentId) return;
  const oldPath = telegramPath(before);
  const newPath = telegramPath(after);
  if (oldPath === newPath && before?.enabled === after?.enabled) return;
  const managedBy = telegramRedirectOwner(documentId);
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

export function telegramWriteScope(before: TelegramRouteState | null, after: TelegramRouteState | null): ScopeRequest {
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

/** Scope for ingested posts / channel settings: repaint the live page only. */
export function telegramFeedScope(page: TelegramRouteState | null): ScopeRequest | null {
  const slug = page?.enabled ? page.slug : null;
  return slug ? { slugs: [slug] } : null;
}
