import { describe, expect, it, vi } from 'vitest';

import createHomepageController from './custom';

function createHarness(homepage: any) {
  const findFirst = vi.fn().mockResolvedValue(homepage);
  const count = vi.fn().mockResolvedValue(0);
  const documents = vi.fn((uid: string) =>
    uid === 'api::homepage.homepage' ? { findFirst } : { count },
  );
  const strapi = {
    documents,
    contentType: vi.fn(() => ({})),
    contentAPI: {
      sanitize: {
        output: vi.fn(async (data: any) => data),
      },
    },
  } as any;
  const ctx = {
    state: { auth: null },
    notFound: vi.fn(),
    send: vi.fn((payload: any) => payload),
  };

  return {
    controller: createHomepageController({ strapi }),
    ctx,
    findFirst,
  };
}

function publishedOffer(index: number) {
  return {
    documentId: `offer-${index}`,
    contentStatus: 'published',
  };
}

describe('homepage aggregate offer population', () => {
  it('filters and sorts Coupon and Deal relations with Document Service-compatible keys', async () => {
    const harness = createHarness({});

    await harness.controller.homepageFull(harness.ctx as any);

    const options = harness.findFirst.mock.calls[0]?.[0];
    const populate = options.populate;
    const publishedRelation = {
      filters: { contentStatus: { $eq: 'published' } },
      sort: ['publishedAt:desc'],
    };

    expect(populate.topDeals.populate.deals).toMatchObject(publishedRelation);
    expect(populate.dealsByBrand.populate.deals).toMatchObject(publishedRelation);
    expect(populate.exploreDeals.populate.tabs.populate.deals).toMatchObject(
      publishedRelation,
    );
    expect(populate.offersByBrand.populate.offers).toMatchObject(publishedRelation);
    expect(populate.exploreOffers.populate.tabs.populate.offers).toMatchObject(
      publishedRelation,
    );
    expect(populate.hero.populate.products.populate.deal.filters).toEqual(
      publishedRelation.filters,
    );
    expect(populate.topOffers.populate.items.populate.coupon.filters).toEqual(
      publishedRelation.filters,
    );
    expect(populate.topDeals.populate.deals).not.toHaveProperty('limit');
    expect(populate.topDeals.populate.deals).not.toHaveProperty('pagination');
  });

  it('removes unpublished rows and caps each list at its own +4 buffer', async () => {
    const published = Array.from({ length: 30 }, (_, index) => publishedOffer(index));
    const expired = { documentId: 'expired', contentStatus: 'expired' };
    const harness = createHarness({
      popularStores: { stores: Array.from({ length: 30 }, (_, i) => ({ documentId: `store-${i}` })) },
      topDeals: { deals: [expired, ...published] },
      offersByBrand: { offers: [expired, ...published] },
      exploreDeals: { tabs: [{ deals: [expired, ...published] }] },
      exploreOffers: { tabs: [{ offers: [expired, ...published] }] },
    });

    const response = await harness.controller.homepageFull(harness.ctx as any);

    expect(response.data.popularStores.stores).toHaveLength(24);
    expect(response.data.topDeals.deals).toHaveLength(10);
    expect(response.data.offersByBrand.offers).toHaveLength(7);
    expect(response.data.exploreDeals.tabs[0].deals).toHaveLength(10);
    expect(response.data.exploreOffers.tabs[0].offers).toHaveLength(10);
    expect(JSON.stringify(response.data)).not.toContain('expired');
  });

  it('drops card-wrapper items whose relation is missing (deleted/expired coupon or deal)', async () => {
    // A deleted coupon — or one the populate filtered out as expired — leaves
    // the wrapper item with a null relation but its own copied image/text.
    const staleItem = { banner: { url: '/stale.png' }, coupon: null };
    const liveItem = { banner: { url: '/live.png' }, coupon: publishedOffer(1) };
    const harness = createHarness({
      hero: { products: [{ deal: null }, { deal: publishedOffer(2) }] },
      topOffers: { items: [staleItem, liveItem] },
      cgExclusive: { items: [staleItem, liveItem] },
      newlyAdded: { items: [staleItem, liveItem] },
      bankOffers: { items: [{ bank: null }, { bank: { documentId: 'bank-1' } }] },
    });

    const response = await harness.controller.homepageFull(harness.ctx as any);

    expect(response.data.hero.products).toHaveLength(1);
    expect(response.data.topOffers.items).toHaveLength(1);
    expect(response.data.cgExclusive.items).toHaveLength(1);
    expect(response.data.newlyAdded.items).toHaveLength(1);
    expect(response.data.bankOffers.items).toHaveLength(1);
    expect(response.data.topOffers.items[0].coupon.documentId).toBe('offer-1');
  });

  it('drops offers past expiresAt even when the cron has not flipped contentStatus yet', async () => {
    const pastExpiry = {
      documentId: 'lagging',
      contentStatus: 'published',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const stillLive = {
      documentId: 'future',
      contentStatus: 'published',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const harness = createHarness({
      topOffers: { items: [{ coupon: pastExpiry }, { coupon: stillLive }] },
      topDeals: { deals: [pastExpiry, stillLive, publishedOffer(1)] },
    });

    const response = await harness.controller.homepageFull(harness.ctx as any);

    expect(response.data.topOffers.items).toHaveLength(1);
    expect(response.data.topOffers.items[0].coupon.documentId).toBe('future');
    expect(response.data.topDeals.deals.map((d: any) => d.documentId)).toEqual([
      'future',
      'offer-1',
    ]);
  });
});
