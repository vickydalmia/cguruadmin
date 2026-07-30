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
  it('ships full offer card content while keeping hero references compact', async () => {
    const harness = createHarness({});

    await harness.controller.homepageFull(harness.ctx as any);

    const populate = harness.findFirst.mock.calls[0]?.[0].populate;
    const couponRefs = [
      populate.topOffers.populate.items.populate.coupon,
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
    expect(populate.popularSearches.populate).toEqual({
      stores: { fields: ['name', 'slug'] },
      brands: { fields: ['name', 'slug'] },
      categories: { fields: ['name', 'slug'] },
      banks: { fields: ['name', 'slug'] },
    });
  });

  it('filters selected Coupon and Deal lists without overriding editor order', async () => {
    const harness = createHarness({});

    await harness.controller.homepageFull(harness.ctx as any);

    const options = harness.findFirst.mock.calls[0]?.[0];
    const populate = options.populate;
    const publishedFilter = { contentStatus: { $eq: 'published' } };

    for (const ref of [
      populate.topDeals.populate.deals,
      populate.dealsByBrand.populate.deals,
      populate.exploreDeals.populate.tabs.populate.deals,
      populate.offersByBrand.populate.offers,
      populate.exploreOffers.populate.tabs.populate.offers,
    ]) {
      expect(ref.filters).toEqual(publishedFilter);
      expect(ref).not.toHaveProperty('sort');
      expect(ref).not.toHaveProperty('limit');
      expect(ref).not.toHaveProperty('pagination');
    }

    // These are also editor-selected multi-relations. They do not need an
    // offer-status filter, but their saved relation order must remain intact.
    for (const ref of [
      populate.popularStores.populate.stores,
      populate.popularSearches.populate.stores,
      populate.popularSearches.populate.brands,
      populate.popularSearches.populate.categories,
      populate.popularSearches.populate.banks,
    ]) {
      expect(ref).not.toHaveProperty('sort');
    }

    // Repeatable component rows use the same drag order and must not acquire a
    // query-level ordering rule either.
    for (const ref of [
      populate.hero.populate.banners,
      populate.hero.populate.products,
      populate.topOffers.populate.items,
      populate.cgExclusive.populate.items,
      populate.exploreDeals.populate.tabs,
      populate.exploreOffers.populate.tabs,
      populate.newlyAdded.populate.items,
      populate.bankOffers.populate.items,
      populate.howItWorks.populate.steps,
      populate.howItWorks.populate.features,
      populate.faq.populate.items,
    ]) {
      expect(ref).not.toHaveProperty('sort');
    }

    expect(populate.hero.populate.products.populate.deal.filters).toEqual(
      publishedFilter,
    );
    expect(populate.topOffers.populate.items.populate.coupon.filters).toEqual(
      publishedFilter,
    );
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

  it('keeps price-less Top Deals and backfills only unusable cards', async () => {
    const curated = [
      actionableDeal(1),
      actionableDeal(2, { dealImage: null }),
      actionableDeal(3, { salePrice: null, mrp: null }),
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
      'offer-3',
      'offer-5',
      'offer-6',
      'offer-7',
      'offer-8',
      'offer-9',
      'offer-10',
      'offer-11',
      'offer-12',
    ]);
    expect(harness.findManyDeals).toHaveBeenCalledTimes(1);
    expect(harness.findManyDeals.mock.calls[0]?.[0]).toMatchObject({
      filters: {
        contentStatus: { $eq: 'published' },
      },
      sort: ['publishedOn:desc', 'publishedAt:desc'],
      limit: 40,
    });
    expect(harness.findManyDeals.mock.calls[0]?.[0].filters).not.toHaveProperty(
      'salePrice',
    );
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

describe('site chrome aggregate population', () => {
  it('populates footer country flags and the Google Preferred icon', async () => {
    const rows: Record<string, any> = {
      'api::menu.menu': {
        documentId: 'menu-1',
        topStores: [],
        searchTopStores: Array.from({ length: 10 }, (_, index) => ({
          store: { documentId: `store-${index}` },
        })),
        searchSuggestions: [
          { text: 'Today’s offers', url: '/todays-deals/' },
        ],
      },
      'api::footer.footer': {
        documentId: 'footer-1',
        countries: [{ code: 'us', name: 'USA', flag: { url: '/usa.png' } }],
        googlePreferredCard: {
          label: 'Add as a preferred source on Google',
          url: 'https://google.com/preferences/source?q=www.couponzguru.com',
          icon: { url: '/google.png' },
        },
      },
      'api::global.global': { documentId: 'global-1' },
    };
    const findFirstByUid = new Map<string, ReturnType<typeof vi.fn>>();
    const documents = vi.fn((uid: string) => {
      const findFirst =
        findFirstByUid.get(uid) ??
        vi.fn().mockResolvedValue(rows[uid] ?? null);
      findFirstByUid.set(uid, findFirst);
      return { findFirst };
    });
    const sanitizeOutput = vi.fn(async (data: any) => data);
    const controller = createHomepageController({
      strapi: {
        documents,
        contentType: vi.fn(() => ({})),
        contentAPI: { sanitize: { output: sanitizeOutput } },
      } as any,
    });
    const ctx = {
      state: { auth: null },
      send: vi.fn((payload: any) => payload),
    };

    const response = await controller.siteChrome(ctx as any);
    const menuCall = findFirstByUid
      .get('api::menu.menu')
      ?.mock.calls[0]?.[0];
    const footerCall = findFirstByUid
      .get('api::footer.footer')
      ?.mock.calls[0]?.[0];

    expect(menuCall.populate.searchTopStores).toEqual({
      populate: { store: expect.any(Object) },
    });
    expect(menuCall.populate.searchSuggestions).toBe(true);
    expect(menuCall.populate.categorySections.populate.icon).toBe(true);
    expect(
      menuCall.populate.categorySections.populate.links.populate.icon,
    ).toBe(true);
    expect(
      menuCall.populate.categorySections.populate.category.populate.icon,
    ).toBe(true);
    expect(response.menu.searchTopStores).toHaveLength(8);
    expect(footerCall.populate.countries).toEqual({
      populate: { flag: true },
    });
    expect(footerCall.populate.googlePreferredCard).toEqual({
      populate: { icon: true },
    });
    expect(response.footer).toEqual(rows['api::footer.footer']);
  });
});

describe('header notification aggregate', () => {
  function notificationHarness(menu: any) {
    const findFirst = vi.fn().mockResolvedValue(menu);
    const sanitizeOutput = vi.fn(async (data: any) => data);
    const controller = createHomepageController({
      strapi: {
        documents: vi.fn(() => ({ findFirst })),
        contentType: vi.fn(() => ({})),
        contentAPI: { sanitize: { output: sanitizeOutput } },
      } as any,
    });
    const ctx = {
      state: { auth: null },
      send: vi.fn((payload: any) => payload),
    };
    return { controller, ctx, findFirst };
  }

  it('emits independent Coupon and Product Deal items with their overrides', async () => {
    const couponOverride = {
      url: '/uploads/coupon-notification.webp',
      alternativeText: 'Coupon notification artwork',
    };
    const dealOverride = {
      url: '/uploads/deal-notification.webp',
      alternativeText: 'Deal notification artwork',
    };
    const harness = notificationHarness({
      notification: {
        coupon: {
          titleOverride: 'Coupon saving live now',
          imageOverride: couponOverride,
          coupon: {
            id: 7,
            title: 'Original Coupon title',
            contentStatus: 'published',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            image: { url: '/uploads/coupon.webp' },
          },
        },
        productDeal: {
          titleOverride: 'Today only: extra savings',
          imageOverride: dealOverride,
          productDeal: {
            id: 42,
            title: 'Original Deal title',
            contentStatus: 'published',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            dealImage: { url: '/uploads/deal.webp' },
          },
        },
      },
    });

    const response = await harness.controller.headerNotification(
      harness.ctx as any,
    );

    expect(response).toEqual({
      data: [
        {
          kind: 'coupon',
          targetId: 7,
          title: 'Coupon saving live now',
          image: couponOverride,
        },
        {
          kind: 'deal',
          targetId: 42,
          title: 'Today only: extra savings',
          image: dealOverride,
        },
      ],
    });
    expect(harness.findFirst.mock.calls[0]?.[0].populate).toEqual(
      expect.objectContaining({
        notification: expect.any(Object),
      }),
    );
  });

  it('falls back per item and omits only the stale offer', async () => {
    const logo = { url: '/uploads/store-logo.webp' };
    const liveHarness = notificationHarness({
      notification: {
        coupon: {
          titleOverride: ' ',
          imageOverride: null,
          coupon: {
            id: 7,
            title: 'AJIO Fashion Sale',
            contentStatus: 'published',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            image: null,
            stores: [{ logo }],
          },
        },
        productDeal: {
          productDeal: {
            id: 8,
            title: 'Expired Product Deal',
            contentStatus: 'published',
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            dealImage: { url: '/uploads/expired.webp' },
          },
        },
      },
    });

    await expect(
      liveHarness.controller.headerNotification(liveHarness.ctx as any),
    ).resolves.toEqual({
      data: [
        {
          kind: 'coupon',
          targetId: 7,
          title: 'AJIO Fashion Sale',
          image: logo,
        },
      ],
    });
  });

  it('returns an empty list when Header Settings do not exist', async () => {
    const harness = notificationHarness(null);
    await expect(
      harness.controller.headerNotification(harness.ctx as any),
    ).resolves.toEqual({ data: [] });
  });
});

describe('public route metadata aggregate', () => {
  it('returns only managed page and active-job indexing metadata', async () => {
    const rows: Record<string, any> = {
      'api::homepage.homepage': {
        documentId: 'home-1',
        updatedAt: '2026-07-23T10:00:00.000Z',
        seo: { noIndex: true },
      },
      'api::about-page.about-page': {
        documentId: 'about-1',
        updatedAt: new Date('2026-07-22T10:00:00.000Z'),
        seo: { noIndex: false },
      },
      'api::career-page.career-page': null,
      'api::deal-of-the-day-page.deal-of-the-day-page': {
        documentId: 'dotd-1',
        seo: { noIndex: true },
      },
    };
    const findFirstByUid = new Map<string, ReturnType<typeof vi.fn>>();
    const findManyJobs = vi.fn().mockResolvedValue([
      {
        documentId: 'job-1',
        slug: 'seo-editor',
        updatedAt: '2026-07-21T10:00:00.000Z',
        seo: { noIndex: true },
      },
      { documentId: 'job-bad', slug: '../admin', seo: { noIndex: false } },
    ]);
    const documents = vi.fn((uid: string) => {
      if (uid === 'api::job.job') return { findMany: findManyJobs };
      const findFirst =
        findFirstByUid.get(uid) ??
        vi.fn().mockResolvedValue(rows[uid] ?? null);
      findFirstByUid.set(uid, findFirst);
      return { findFirst };
    });
    const controller = createHomepageController({
      strapi: { documents } as any,
    });
    const ctx = { send: vi.fn((payload: any) => payload) };

    const response = await controller.publicRouteMetadata(ctx as any);

    expect(response.data).toEqual([
      {
        path: '/',
        updatedAt: '2026-07-23T10:00:00.000Z',
        noIndex: true,
      },
      {
        path: '/about-us/',
        updatedAt: '2026-07-22T10:00:00.000Z',
        noIndex: false,
      },
      {
        path: '/deal-of-the-day/',
        noIndex: true,
      },
      {
        path: '/careers/seo-editor/',
        updatedAt: '2026-07-21T10:00:00.000Z',
        noIndex: true,
      },
    ]);
    expect(findManyJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { isActive: true },
        fields: ['documentId', 'slug', 'updatedAt'],
        populate: { seo: { fields: ['noIndex'] } },
      }),
    );
    for (const findFirst of findFirstByUid.values()) {
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: ['documentId', 'updatedAt'],
          populate: { seo: { fields: ['noIndex'] } },
        }),
      );
    }
  });
});
