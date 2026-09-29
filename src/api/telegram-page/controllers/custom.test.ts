import { describe, expect, it, vi } from 'vitest';
import createTelegramPageController from './custom';
import { TELEGRAM_PAGE_POPULATE } from './telegram-page-populate';

vi.mock('../../../telegram/state', () => ({
  readTelegramIngestState: vi.fn(async () => ({ memberCount: 12_942, channel: '-1001', chatId: '-1001' })),
}));

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function post(messageId: number, overrides: Record<string, unknown> = {}) {
  return {
    documentId: `post-${messageId}`,
    messageId,
    chatId: '-1001',
    postedAt: `2026-09-${String(messageId).padStart(2, '0')}T00:00:00.000Z`,
    title: `Post ${messageId}`,
    text: 'caption',
    entities: [{ type: 'url', offset: 0, length: 3 }],
    salePrice: '499.00',
    mrp: null,
    discountLabel: null,
    ctaUrl: 'https://www.amazon.in/dp/x',
    storeDomain: 'amazon.in',
    permalink: `https://t.me/cg/${messageId}`,
    photo: { url: '/uploads/p.jpg' },
    hidden: false,
    ...overrides,
  };
}

function harness(page: any, posts: any[], stores: any[] = []) {
  const findMany = vi.fn(async () => posts);
  const storeFindMany = vi.fn(async () => stores);
  const strapi = {
    documents: vi.fn((uid: string) => {
      if (uid === 'api::telegram-page.telegram-page') return { findFirst: vi.fn(async () => page) };
      if (uid === 'api::telegram.telegram') return { findFirst: vi.fn(async () => ({ feedPostCount: 2, botToken: TOKEN, channel: '-1001' })) };
      if (uid === 'api::store.store') return { findMany: storeFindMany };
      return { findMany };
    }),
    contentType: vi.fn(() => ({})),
    contentAPI: {
      sanitize: {
        output: vi.fn(async (data: any) => {
          // Mirror Strapi's private-field stripping for the fields that matter.
          const { entities, botToken, photoFileUniqueId, ...rest } = data;
          return rest;
        }),
      },
    },
  } as any;
  const ctx: any = { query: {}, state: {}, notFound: vi.fn((message: string) => ({ notFound: message })), send: vi.fn((body: any) => body) };
  return { strapi, ctx, findMany, storeFindMany };
}

describe('GET /telegram-page-full', () => {
  it('returns null data when the singleton is missing or disabled', async () => {
    for (const page of [null, { enabled: false, slug: 'join-telegram' }, { enabled: true, slug: 'Bad Slug' }]) {
      const { strapi, ctx } = harness(page, []);
      const body: any = await createTelegramPageController({ strapi }).telegramPageFull(ctx);
      expect(body).toEqual({ data: null });
    }
  });

  it('returns the page with the newest visible posts, store badges and the member count', async () => {
    const { strapi, ctx, findMany, storeFindMany } = harness(
      { title: 'Telegram Page', enabled: true, slug: 'join-telegram', hero: { titleLead: 'Never Miss a' } },
      [post(2), post(1, { storeDomain: null })],
      [{ name: 'Amazon', slug: 'amazon', websiteUrl: 'https://www.amazon.in/', logo: { url: '/amazon.svg' }, logoAlt: 'Amazon' }],
    );
    const controller = createTelegramPageController({ strapi });
    const body: any = await controller.telegramPageFull(ctx);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ filters: { hidden: false, chatId: '-1001' }, sort: ['postedAt:desc', 'messageId:desc'], limit: 2 }));
    expect(storeFindMany).toHaveBeenCalledTimes(1);
    expect(body.data.hero).toEqual({ titleLead: 'Never Miss a' });
    expect(body.data.memberCount).toBe(12_942);
    expect(body.data.latestPosts).toHaveLength(2);
    expect(body.data.latestPosts[0]).toMatchObject({
      id: 'post-2',
      messageId: 2,
      salePrice: 499,
      store: { name: 'Amazon', slug: 'amazon', logoAlt: 'Amazon' },
    });
    expect(body.data.latestPosts[1].store).toBeNull();
    // Private fields never leave the API.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('"entities"');
  });

  it('populates the store logos through the shared store projection', () => {
    expect((TELEGRAM_PAGE_POPULATE.favouriteStores as any).populate.stores.populate.logo).toBe(true);
    expect(TELEGRAM_PAGE_POPULATE.hero.populate.previewCards.populate.icon).toBe(true);
  });
});
