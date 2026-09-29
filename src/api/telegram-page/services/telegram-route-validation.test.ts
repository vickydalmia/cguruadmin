import { validateSubscriptionRoutes } from '../../subscription-page/services/subscription-route-validation';
import { describe, expect, it, vi } from 'vitest';
import { validateTelegramRoutes } from './telegram-route-validation';
import { telegramRouteMetadata } from './telegram-route';
import { TELEGRAM_PAGE_UID } from '../../../constants/telegram';

const SUBSCRIPTION_UID = 'api::subscription-page.subscription-page';
const page = { documentId: 'tg', slug: 'join-telegram', enabled: true };
function cms(saved: any = page, entities: any[] = [], redirects: any[] = [], subscription: any = null) {
  return { documents: vi.fn((uid: string) => ({
    findFirst: vi.fn(async () => uid === TELEGRAM_PAGE_UID ? saved : uid === SUBSCRIPTION_UID ? subscription : null),
    findOne: vi.fn(async () => uid === TELEGRAM_PAGE_UID ? saved : null),
    findMany: vi.fn(async () => uid === 'api::redirect.redirect' ? redirects : entities),
  })) } as any;
}

describe('telegram URL reservations', () => {
  it.each(['about-us', 'search', 'api'])('rejects reserved slug %s', async (slug) => {
    await expect(validateTelegramRoutes(cms(), TELEGRAM_PAGE_UID, { slug })).rejects.toThrow(/belongs/);
  });
  it('rejects entity, generated product-deal and subscription URLs', async () => {
    await expect(validateTelegramRoutes(cms(page, [{ name: 'Amazon', slug: 'amazon-coupons' }]), TELEGRAM_PAGE_UID, { slug: 'amazon-coupons' })).rejects.toThrow(/reserved/);
    await expect(validateTelegramRoutes(cms(page, [{ name: 'Amazon', slug: 'amazon-coupons' }]), TELEGRAM_PAGE_UID, { slug: 'amazon-deals' })).rejects.toThrow(/reserved/);
    await expect(validateTelegramRoutes(cms(page, [], [], { slug: 'subscribe' }), TELEGRAM_PAGE_UID, { slug: 'subscribe' })).rejects.toThrow(/Subscription/);
  });
  it('rejects active redirects but permits the page to return to its own alias', async () => {
    await expect(validateTelegramRoutes(cms(page, [], [{ from: '/tg', active: true }]), TELEGRAM_PAGE_UID, { slug: 'tg' })).rejects.toThrow(/redirect/);
    await expect(validateTelegramRoutes(cms(page, [], [{ from: '/tg', managedBy: 'telegram-page:tg' }]), TELEGRAM_PAGE_UID, { slug: 'tg' })).resolves.toBeUndefined();
  });
  it('prevents entities, redirects and the subscription page taking the saved slug, even while disabled', async () => {
    const strapi = cms({ ...page, enabled: false });
    await expect(validateTelegramRoutes(strapi, 'api::store.store', { slug: 'join-telegram' })).rejects.toThrow(/Telegram/);
    await expect(validateTelegramRoutes(strapi, 'api::redirect.redirect', { from: '/join-telegram/', to: '/x/' })).rejects.toThrow(/Telegram/);
    await expect(validateTelegramRoutes(strapi, SUBSCRIPTION_UID, { slug: 'join-telegram' })).rejects.toThrow(/Telegram/);
    await expect(validateTelegramRoutes(strapi, SUBSCRIPTION_UID, { title: 'x' })).resolves.toBeUndefined();
  });
  it('exposes membership only when enabled', async () => {
    expect(await telegramRouteMetadata(cms({ ...page, seo: { noIndex: true } }), 'ar')).toEqual([expect.objectContaining({ path: '/join-telegram/', pageType: 'telegram', noIndex: true })]);
    expect(await telegramRouteMetadata(cms({ ...page, enabled: false }), 'en')).toEqual([]);
    expect(await telegramRouteMetadata(cms(null), 'en')).toEqual([]);
  });
});


describe.each([
  [TELEGRAM_PAGE_UID, validateTelegramRoutes, 'join-telegram'],
  [SUBSCRIPTION_UID, validateSubscriptionRoutes, 'subscription'],
] as const)('shared singleton reservations: %s', (uid, validate, slug) => {
  function harness() {
    const findMany = vi.fn(async () => [] as any[]);
    const strapi = { documents: vi.fn((target: string) => ({
      findFirst: async () => target === uid ? { documentId: 'page', slug, enabled: true } : null,
      findMany,
    })) } as any;
    return { strapi, findMany };
  }
  it.each(['en', 'ar'])('does not scan the catalogue for copy-only %s saves', async locale => {
    const { strapi, findMany } = harness();
    await validate(strapi, uid, { slug, hero: { titleLead: 'Edited copy' } }, 'page', locale);
    expect(findMany).not.toHaveBeenCalled();
  });
  it('rejects a reserved shared slug from Arabic before synchronization', async () => {
    const { strapi } = harness();
    await expect(validate(strapi, uid, { slug: 'about-us' }, 'page', 'ar')).rejects.toThrow(/belongs/);
  });
  it('finds a collision after redirect 2000', async () => {
    const { strapi } = harness();
    const redirects = Array.from({ length: 2051 }, (_, i) => ({ from: i === 2050 ? '/late-alias/' : `/other-${i}/` }));
    const original = strapi.documents;
    strapi.documents = (target: string) => ({ ...original(target), findMany: async ({ start = 0, limit = 500 }: any) => target === 'api::redirect.redirect' ? redirects.slice(start, start + limit) : [] });
    await expect(validate(strapi, uid, { slug: 'late-alias' }, 'page', 'ar')).rejects.toThrow(/redirect/);
  });
});
