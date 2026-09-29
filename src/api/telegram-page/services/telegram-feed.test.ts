import { describe, expect, it, vi } from 'vitest';
import { buildTelegramFeed } from './telegram-feed';

const state = vi.hoisted(() => ({ value: {} as any }));
vi.mock('../../../telegram/state', () => ({ readTelegramIngestState: async () => state.value }));
function cms(channel: string, stores: any[] = []) {
  const posts = vi.fn(async () => [{ documentId: 'p', messageId: 1, storeDomain: 'amazon.in' }]);
  const strapi = {
    documents: (uid: string) => uid === 'api::telegram.telegram'
      ? { findFirst: async () => ({ channel, feedPostCount: 6 }) }
      : uid === 'api::store.store' ? { findMany: async () => stores } : { findMany: posts },
    contentType: () => ({}),
    contentAPI: { sanitize: { output: async (data: any) => data } },
  } as any;
  return { strapi, posts };
}
describe('Telegram feed channel boundaries', () => {
  it('retains pre-upgrade public posts using the configured channel permalink', async () => {
    state.value = { memberCount: 12 };
    const { strapi, posts } = cms('@CouponzGuru');
    const result = await buildTelegramFeed(strapi, { state: {}, query: {} });
    expect(posts).toHaveBeenCalledWith(expect.objectContaining({
      filters: { hidden: false, permalink: { $startsWithi: 'https://t.me/couponzguru/' } },
    }));
    expect(result.memberCount).toBeNull();
  });
  it('does not query the previous channel when settings change', async () => {
    state.value = { channel: '@old', chatId: '-1001', memberCount: 12 };
    const { strapi, posts } = cms('@new');
    const result = await buildTelegramFeed(strapi, { state: {}, query: {} });
    expect(posts).toHaveBeenCalledWith(expect.objectContaining({
      filters: { hidden: false, permalink: { $startsWithi: 'https://t.me/new/' } },
    }));
    expect(result.memberCount).toBeNull();
  });
  it('rejects store domain lookalikes while matching the actual merchant', async () => {
    state.value = { channel: '-1001', chatId: '-1001', memberCount: 12 };
    const { strapi } = cms('-1001', [
      { name: 'Imposter', slug: 'imposter', websiteUrl: 'https://amazon.in.evil.example/' },
      { name: 'Amazon', slug: 'amazon', websiteUrl: 'https://www.amazon.in/' },
    ]);
    const result = await buildTelegramFeed(strapi, { state: {}, query: {} });
    expect(result.posts[0].store?.name).toBe('Amazon');
  });
});
