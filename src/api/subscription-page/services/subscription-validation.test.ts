import { describe, expect, it, vi } from 'vitest';
import { subscriptionContentProblems, validateSubscriptionContent, validSubscriptionHref } from './subscription-validation';
import { validateSubscriptionRoutes } from './subscription-route-validation';
import { SUBSCRIPTION_PAGE_UID, subscriptionRouteMetadata } from './subscription-route';

const page = { documentId: 'subscription', slug: 'subscribe', enabled: true, hero: { headingBefore: 'Keep in touch' } };
function cms(saved: any = page, entities: any[] = [], redirects: any[] = []) {
  return { documents: vi.fn((uid: string) => ({
    findFirst: vi.fn(async () => uid === SUBSCRIPTION_PAGE_UID ? saved : null),
    findOne: vi.fn(async () => uid === SUBSCRIPTION_PAGE_UID ? saved : null),
    findMany: vi.fn(async () => uid === 'api::redirect.redirect' ? redirects : entities),
  })) } as any;
}

describe('subscription content', () => {
  it('accepts missing optional sections and rejects an enabled page with no heading', () => {
    expect(subscriptionContentProblems(page)).toEqual([]);
    expect(subscriptionContentProblems({ ...page, hero: null })).toEqual([expect.objectContaining({ path: ['hero'] })]);
    expect(subscriptionContentProblems({ slug: 'subscribe', enabled: false })).toEqual([]);
  });
  it.each(['javascript:alert(1)', '//evil.com', '/\\evil.com', 'https://user:pass@site.com', 'not-a-url'])('rejects unsafe destinations: %s', (href) => {
    expect(validSubscriptionHref(href)).toBe(false);
  });
  it.each(['https://t.me/couponzguru', '/telegram/'])('accepts destinations: %s', (href) => expect(validSubscriptionHref(href)).toBe(true));
  it('validates enabled cards and lets editors disable incomplete sections', () => {
    const card = { platform: 'telegram', name: 'Telegram', ctaLabel: 'Join', ctaHref: 'https://t.me/example' };
    expect(subscriptionContentProblems({ ...page, platforms: { heading: 'Platforms', cards: [card, card] } })).toEqual([expect.objectContaining({ path: ['platforms', 'cards', 1, 'platform'] })]);
    expect(subscriptionContentProblems({ ...page, platforms: { enabled: false, cards: [{}] } })).toEqual([]);
  });
  it('merges partial updates and honours explicit component removal', async () => {
    const strapi = cms({ ...page, signup: { heading: 'Email', emailLabel: 'Email', emailPlaceholder: 'Email', ctaLabel: 'Subscribe' } });
    await expect(validateSubscriptionContent(strapi, { signup: { ctaLabel: 'Join' } })).resolves.toBeUndefined();
    await expect(validateSubscriptionContent(strapi, { signup: null })).resolves.toBeUndefined();
    await expect(validateSubscriptionContent(strapi, { hero: null })).rejects.toThrow(/heading/);
  });
});

describe('subscription URL reservations', () => {
  it.each(['about-us', 'privacy-policy', 'search', 'api'])('rejects reserved slug %s', async (slug) => {
    await expect(validateSubscriptionRoutes(cms(), SUBSCRIPTION_PAGE_UID, { slug })).rejects.toThrow(/belongs/);
  });
  it('rejects both existing entity and generated product-deal URLs', async () => {
    await expect(validateSubscriptionRoutes(cms(page, [{ name: 'Amazon', slug: 'amazon-coupons' }]), SUBSCRIPTION_PAGE_UID, { slug: 'amazon-coupons' })).rejects.toThrow(/reserved/);
    await expect(validateSubscriptionRoutes(cms(page, [{ name: 'Amazon', slug: 'amazon-coupons' }]), SUBSCRIPTION_PAGE_UID, { slug: 'amazon-deals' })).rejects.toThrow(/reserved/);
  });
  it('rejects active redirects but permits the page to return to its own alias', async () => {
    await expect(validateSubscriptionRoutes(cms(page, [], [{ from: '/join', active: true }]), SUBSCRIPTION_PAGE_UID, { slug: 'join' })).rejects.toThrow(/redirect/);
    await expect(validateSubscriptionRoutes(cms(page, [], [{ from: '/join', managedBy: 'subscription-page:subscription' }]), SUBSCRIPTION_PAGE_UID, { slug: 'join' })).resolves.toBeUndefined();
  });
  it('prevents entities and redirects taking a saved singleton URL, including when disabled', async () => {
    const strapi = cms({ ...page, enabled: false });
    await expect(validateSubscriptionRoutes(strapi, 'api::store.store', { slug: 'subscribe' })).rejects.toThrow(/Subscription/);
    await expect(validateSubscriptionRoutes(strapi, 'api::redirect.redirect', { from: '/subscribe/', to: '/elsewhere/' })).rejects.toThrow(/Subscription/);
    await expect(validateSubscriptionRoutes(cms({ ...page, slug: 'amazon-deals' }), 'api::store.store', { name: 'Amazon' })).rejects.toThrow(/generated/);
  });
  it('exposes membership only when enabled and carries metadata for the requested language', async () => {
    expect(await subscriptionRouteMetadata(cms({ ...page, seo: { noIndex: true } }), 'ar')).toEqual([expect.objectContaining({ path: '/subscribe/', pageType: 'subscription', noIndex: true })]);
    expect(await subscriptionRouteMetadata(cms({ ...page, enabled: false }), 'en')).toEqual([]);
    expect(await subscriptionRouteMetadata(cms(null), 'en')).toEqual([]);
  });
});
