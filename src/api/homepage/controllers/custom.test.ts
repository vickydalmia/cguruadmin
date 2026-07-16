import { describe, expect, it, vi } from 'vitest';

import createHomepageController from './custom';

function createHarness(homepage: any, fallbackDeals: any[] = []) {
  const findFirst = vi.fn().mockResolvedValue(homepage);
  const findManyDeals = vi.fn().mockResolvedValue(fallbackDeals);
  const count = vi.fn().mockResolvedValue(0);
  const documents = vi.fn((uid: string) => {
    if (uid === 'api::homepage.homepage') return { findFirst };
    if (uid === 'api::deal.deal') return { count, findMany: findManyDeals };
    return { count };
  });
  const sanitizeOutput = vi.fn(async (data: any) => data);
  const strapi = {
    documents,
    contentType: vi.fn(() => ({})),
    contentAPI: {
      sanitize: {
        output: sanitizeOutput,
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
    findManyDeals,
    sanitizeOutput,
  };
}

function publishedOffer(index: number) {
  return {
    documentId: `offer-${index}`,
    contentStatus: 'published',
  };
}

function actionableDeal(index: number, overrides: Record<string, any> = {}) {
  return {
    ...publishedOffer(index),
    content: `<p>Product Deal ${index} description.</p>`,
    dealImage: { url: `/deal-${index}.webp` },
    salePrice: 999,
    affiliateLink: `https://merchant.example/deal-${index}`,
    ...overrides,
  };
}

describe('homepage aggregate offer population', () => {
  it('ships full card content without bloating compact entity and hero references', async () => {
    const harness = createHarness({});

    await harness.controller.homepageFull(harness.ctx as any);

    const populate = harness.findFirst.mock.calls[0]?.[0].populate;
    const couponRefs = [
      populate.cgExclusive.populate.items.populate.coupon,
      populate.newlyAdded.populate.items.populate.coupon,
      populate.offersByBrand.populate.offers,
      populate.exploreOffers.populate.tabs.populate.offers,
    ];
    const fullDealRefs = [
      populate.topDeals.populate.deals,
      populate.dealsByBrand.populate.deals,
      populate.exploreDeals.populate.tabs.populate.deals,
    ];

    for (const ref of [...couponRefs, ...fullDealRefs]) {
      expect(ref.fields).toContain('content');
      expect(ref.fields).not.toContain('excerpt');
    }

    const heroDeal = populate.hero.populate.products.populate.deal;
    expect(heroDeal.fields).not.toContain('content');
    expect(heroDeal.fields).not.toContain('excerpt');

    const topOfferCoupon = populate.topOffers.populate.items.populate.coupon;
    expect(topOfferCoupon.fields).not.toContain('content');
    expect(topOfferCoupon.fields).not.toContain('excerpt');

    expect(populate.popularStores.populate.featuredStore.fields).not.toContain(
      'shortDescription',
    );
    expect(
      populate.topOffers.populate.items.populate.coupon.populate.brands.fields,
    ).not.toContain('shortDescription');
    expect(
      populate.exploreOffers.populate.tabs.populate.category.fields,
    ).not.toContain('shortDescription');
    expect(populate.bankOffers.populate.items.populate.bank.fields).toContain(
      'shortDescription',
    );
  });

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
      // enabled:false pins the raw drop/cap path — backfill (tested separately)
      // would replace these bare curated records as non-actionable.
      topDeals: { enabled: false, deals: [expired, ...published] },
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
      // enabled:false pins the expiry-drop path without backfill interference.
      topDeals: { enabled: false, deals: [pastExpiry, stillLive, publishedOffer(1)] },
    });

    const response = await harness.controller.homepageFull(harness.ctx as any);

    expect(response.data.topOffers.items).toHaveLength(1);
    expect(response.data.topOffers.items[0].coupon.documentId).toBe('future');
    expect(response.data.topDeals.deals.map((d: any) => d.documentId)).toEqual([
      'future',
      'offer-1',
    ]);
  });

  it('fills Top Deals to its buffer with actionable Deal-schema records only', async () => {
    const curated = [
      actionableDeal(1),
      actionableDeal(2, { dealImage: null }),
      actionableDeal(3, { salePrice: 0 }),
      actionableDeal(4, { affiliateLink: 'javascript:alert(1)' }),
    ];
    const fallback = [
      actionableDeal(1),
      ...Array.from({ length: 12 }, (_, index) => actionableDeal(index + 5)),
    ];
    const harness = createHarness(
      { topDeals: { enabled: true, deals: curated } },
      fallback,
    );

    const response = await harness.controller.homepageFull(harness.ctx as any);

    expect(response.data.topDeals.deals).toHaveLength(10);
    expect(
      response.data.topDeals.deals.map((deal: any) => deal.documentId),
    ).toEqual([
      'offer-1',
      'offer-5',
      'offer-6',
      'offer-7',
      'offer-8',
      'offer-9',
      'offer-10',
      'offer-11',
      'offer-12',
      'offer-13',
    ]);
    expect(harness.findManyDeals).toHaveBeenCalledTimes(1);
    expect(harness.findManyDeals.mock.calls[0]?.[0]).toMatchObject({
      filters: {
        contentStatus: { $eq: 'published' },
        salePrice: { $notNull: true, $gt: 0 },
      },
      sort: ['publishedAt:desc'],
      limit: 40,
    });
    expect(harness.findManyDeals.mock.calls[0]?.[0].fields).toContain('content');
    expect(harness.findManyDeals.mock.calls[0]?.[0].fields).not.toContain(
      'excerpt',
    );
    expect(harness.findManyDeals.mock.calls[0]?.[0].populate).toHaveProperty(
      'dealImage',
      true,
    );
    expect(harness.sanitizeOutput).toHaveBeenCalledWith(
      fallback,
      {},
      { auth: null },
    );
  });

  it('does not query fallback Deals when six curated Top Deals are actionable', async () => {
    const harness = createHarness({
      topDeals: {
        enabled: true,
        deals: Array.from({ length: 6 }, (_, index) => actionableDeal(index)),
      },
    });

    const response = await harness.controller.homepageFull(harness.ctx as any);

    expect(response.data.topDeals.deals).toHaveLength(6);
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });
});
