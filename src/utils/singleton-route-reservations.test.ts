import { expect, it } from 'vitest';
import { syncSubscriptionRedirects } from '../api/subscription-page/services/subscription-write';
import { syncTelegramRedirects } from '../api/telegram-page/services/telegram-write';
import { validateRedirect } from './redirect-validation';

it.each([syncSubscriptionRedirects, syncTelegramRedirects])('reactivates free aliases while preserving reclaimed URLs', async sync => {
  const aliases = [
    { documentId: 'store-alias', from: '/reclaimed/', to: '/old-target/', active: false },
    { documentId: 'page-alias', from: '/other-page/', to: '/old-target/', active: false },
    { documentId: 'free-alias', from: '/free-alias/', to: '/old-target/', active: false },
  ];
  const strapi: any = { documents: (uid: string) => ({
    findFirst: async () => ({ slug: uid === 'api::telegram-page.telegram-page' ? 'other-page' : 'current-name' }),
    findOne: async ({ documentId }: any) => aliases.find(row => row.documentId === documentId),
    findMany: async (params: any) => {
      if (uid === 'api::redirect.redirect') return params.filters?.managedBy ? aliases : aliases.filter(row => row.active);
      return uid === 'api::store.store' && params.filters?.$or?.some((clause: any) => clause.slug.$eqi === 'reclaimed')
        ? [{ name: 'New store', slug: 'reclaimed' }] : [];
    },
    count: async () => aliases.filter(row => row.active).length,
    update: async ({ documentId, data }: any) => {
      await validateRedirect(strapi, uid, 'update', data, documentId, true);
      Object.assign(aliases.find(row => row.documentId === documentId)!, data);
    },
  }) };
  await sync(strapi, { documentId: 'page', slug: 'current-name', enabled: false }, { documentId: 'page', slug: 'current-name', enabled: true });
  expect(aliases[0].active).toBe(false);
  expect(aliases[1].active).toBe(false);
  expect(aliases[2]).toMatchObject({ active: true, to: '/current-name/' });
});
