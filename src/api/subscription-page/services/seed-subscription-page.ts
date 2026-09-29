import type { Core } from '@strapi/strapi';
import initialPage from '../content/initial-subscription-page.json';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { acquireWriteSerializationLock } from '../../../utils/write-serialization';
import { readSubscriptionRoute, SUBSCRIPTION_PAGE_UID } from './subscription-route';

/** One-time installation data, then entirely owned by Content Manager. */
export async function seedSubscriptionPage(strapi: Core.Strapi): Promise<void> {
  const marker = strapi.store({ type: 'core', name: 'subscription-page' });
  const key = 'initial-content-v1';
  if (await marker.get({ key })) return;
  await strapi.db.transaction(async ({ trx }) => {
    await acquireWriteSerializationLock(strapi, 'identity', trx);
    if (await marker.get({ key })) return;
    if (!await readSubscriptionRoute(strapi)) {
      // Figma has copy and artwork but no real channel destinations or entity
      // IDs. Keep the page disabled until those are configured in the admin.
      await strapi.documents(SUBSCRIPTION_PAGE_UID as any).create({
        locale: DEFAULT_CONTENT_LOCALE,
        data: structuredClone(initialPage) as any,
      });
    }
    // Survives deletion too: a later boot must not resurrect an editor's page.
    // Core store and documents both join the ambient content transaction.
    await marker.set({ key, value: true });
  });
}
