import { describe, expect, it, vi } from 'vitest';

import createDealOfTheDayController from './custom';

const PAGE_UID = 'api::deal-of-the-day-page.deal-of-the-day-page';

function createHarness(page: any, fallbackDeals: any[] = [], counts: number | ((args: any) => number) = 0) {
  const findFirst = vi.fn().mockResolvedValue(page);
  const findManyDeals = vi.fn().mockResolvedValue(fallbackDeals);
  const count = vi.fn(async (args: any) =>
    typeof counts === 'function' ? counts(args) : counts,
  );
  const documents = vi.fn((uid: string) => {
    if (uid === PAGE_UID) return { findFirst };
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
    notFound: vi.fn(() => 'not-found'),
    send: vi.fn((payload: any) => payload),
  };

  return {
    controller: createDealOfTheDayController({ strapi }),
    ctx,
    findFirst,
    findManyDeals,
    count,
    sanitizeOutput,
  };
}

function publishedDeal(index: number) {
  return {
    documentId: `deal-${index}`,
    contentStatus: 'published',
  };
}

function actionableDeal(index: number, overrides: Record<string, any> = {}) {
  return {
    ...publishedDeal(index),
    content: `<p>Product Deal ${index} description.</p>`,
    dealImage: { url: `/deal-${index}.webp` },
    salePrice: 999,
    affiliateLink: `https://merchant.example/deal-${index}`,
    ...overrides,
  };
}

function benefitDeal(index: number, overrides: Record<string, any> = {}) {
  return actionableDeal(index, {
    cashbackText: '15% Cashback',
    bankOfferText: '12% Bank OFF',
    ...overrides,
  });
}

describe('deal-of-the-day aggregate population', () => {
  it('404s when the single type has never been saved', async () => {
    const harness = createHarness(null);

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(harness.ctx.notFound).toHaveBeenCalledWith('Deal of the day page not found');
    expect(response).toBe('not-found');
    expect(harness.ctx.send).not.toHaveBeenCalled();
  });

  it('ships full card content except in the compact Gen-Z and Telegram sections', async () => {
    const harness = createHarness({});

    await harness.controller.dealOfTheDayFull(harness.ctx as any);

    const populate = harness.findFirst.mock.calls[0]?.[0].populate;
    const fullDealRefs = [
      populate.topPicks.populate.deals,
      populate.topDeals.populate.deals,
      populate.dealsByCategory.populate.tabs.populate.deals,
      populate.dealsByStore.populate.tabs.populate.deals,
      populate.smartSavingStack.populate.deals,
      populate.trendingNow.populate.deals,
      populate.allDeals.populate.deals,
    ];
    for (const ref of fullDealRefs) {
      expect(ref.fields).toContain('content');
      expect(ref.fields).toContain('badge');
      expect(ref.fields).toContain('code');
    }

    expect(populate.genZDrops.populate.deals.fields).not.toContain('content');
    expect(populate.genZDrops.populate.deals.fields).toContain('code');

    // Telegram-exclusive deals are join-gated: no rich text, and the promo
    // code never leaves the API. The component also has no viewAllCta field.
    expect(populate.telegramDeals.populate.deals.fields).not.toContain('content');
    expect(populate.telegramDeals.populate.deals.fields).not.toContain('code');
    expect(populate.telegramDeals.populate).not.toHaveProperty('viewAllCta');

    // `iconAlt` rides along with the icon so the site can label it — the
    // category counterpart of logoAlt on store/brand/bank.
    expect(populate.dealsByCategory.populate.tabs.populate.category.fields).toEqual([
      'name',
      'slug',
      'iconAlt',
    ]);
    expect(populate.dealsByStore.populate.tabs.populate.store.fields).toEqual([
      'name',
      'slug',
      'logoAlt',
    ]);
  });

  it('preserves editor order for every selected Deal relation', async () => {
    const harness = createHarness({});

    await harness.controller.dealOfTheDayFull(harness.ctx as any);

    const populate = harness.findFirst.mock.calls[0]?.[0].populate;
    const publishedFilter = { contentStatus: { $eq: 'published' } };

    for (const ref of [
      populate.dealsByCategory.populate.tabs.populate.deals,
      populate.dealsByStore.populate.tabs.populate.deals,
      populate.allDeals.populate.deals,
    ]) {
      expect(ref).not.toHaveProperty('filters');
      expect(ref).not.toHaveProperty('sort');
    }

    expect(populate.dealsByCategory.populate.tabs).not.toHaveProperty('sort');
    expect(populate.dealsByStore.populate.tabs).not.toHaveProperty('sort');

    for (const ref of [
      populate.topPicks.populate.deals,
      populate.topDeals.populate.deals,
      populate.trendingNow.populate.deals,
      populate.genZDrops.populate.deals,
      populate.telegramDeals.populate.deals,
    ]) {
      expect(ref.filters).toEqual(publishedFilter);
      expect(ref).not.toHaveProperty('sort');
      expect(ref).not.toHaveProperty('limit');
      expect(ref).not.toHaveProperty('pagination');
    }
    expect(populate.smartSavingStack.populate.deals).not.toHaveProperty('filters');
    expect(populate.smartSavingStack.populate.deals).not.toHaveProperty('sort');
  });

  it('removes dead rows and caps each list at its own buffer', async () => {
    const published = Array.from({ length: 30 }, (_, index) => publishedDeal(index));
    const expired = { documentId: 'expired', contentStatus: 'expired' };
    const harness = createHarness({
      topPicks: { deals: [expired, ...published] },
      smartSavingStack: {
        enabled: false,
        deals: [
          expired,
          ...published.map((deal) => ({
            ...deal,
            cashbackText: '15% Cashback',
            bankOfferText: '12% Bank OFF',
          })),
        ],
      },
      trendingNow: { deals: [expired, ...published] },
      genZDrops: { deals: [expired, ...published] },
      telegramDeals: { deals: [expired, ...published] },
      // enabled:false pins the raw drop/cap path — backfill (tested separately)
      // would replace these bare curated records as non-actionable.
      dealsByCategory: {
        enabled: false,
        tabs: [
          { category: { documentId: 'cat-1' }, deals: [expired, ...published] },
          { category: null, deals: published },
        ],
      },
      dealsByStore: {
        enabled: false,
        tabs: [
          { store: { documentId: 'store-1' }, deals: [expired, ...published] },
          { store: null, deals: published },
        ],
      },
    });

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.topPicks.deals).toHaveLength(4);
    expect(response.data.smartSavingStack.deals).toHaveLength(30);
    expect(response.data.trendingNow.deals).toHaveLength(10);
    expect(response.data.genZDrops.deals).toHaveLength(6);
    expect(response.data.telegramDeals.deals).toHaveLength(6);
    expect(response.data.dealsByCategory.tabs).toHaveLength(1);
    expect(response.data.dealsByCategory.tabs[0].deals).toHaveLength(10);
    expect(response.data.dealsByStore.tabs).toHaveLength(1);
    expect(response.data.dealsByStore.tabs[0].deals).toHaveLength(10);
    expect(JSON.stringify(response.data)).not.toContain('expired');
  });

  it('drops deals past expiresAt even when the cron has not flipped contentStatus yet', async () => {
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
      trendingNow: { deals: [pastExpiry, stillLive, publishedDeal(1)] },
    });

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.trendingNow.deals.map((d: any) => d.documentId)).toEqual([
      'future',
      'deal-1',
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

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(
      response.data.topDeals.deals.map((deal: any) => deal.documentId),
    ).toEqual([
      'deal-1',
      'deal-3',
      'deal-5',
      'deal-6',
      'deal-7',
      'deal-8',
      'deal-9',
      'deal-10',
      'deal-11',
      'deal-12',
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
  });

  it('does not query fallback Deals when six curated Top Deals are actionable', async () => {
    const harness = createHarness({
      topDeals: {
        enabled: true,
        deals: Array.from({ length: 6 }, (_, index) => actionableDeal(index)),
      },
    });

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.topDeals.deals).toHaveLength(6);
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('keeps selected category Deals exclusive and does not query category fallback', async () => {
    const harness = createHarness(
      {
        dealsByCategory: {
          enabled: true,
          tabs: [{ category: { documentId: 'cat-1' }, deals: [actionableDeal(1)] }],
        },
      },
      Array.from({ length: 12 }, (_, index) => actionableDeal(index + 20)),
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.dealsByCategory.tabs[0].deals).toHaveLength(1);
    expect(response.data.dealsByCategory.tabs[0].deals[0].documentId).toBe('deal-1');
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('queries category membership only when no category Deals are selected', async () => {
    const fallback = Array.from({ length: 12 }, (_, index) => actionableDeal(index + 20));
    const harness = createHarness({
      dealsByCategory: {
        enabled: true,
        tabs: [{ category: { documentId: 'cat-1' }, deals: [] }],
      },
    }, fallback);

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(harness.findManyDeals).toHaveBeenCalledTimes(1);
    expect(harness.findManyDeals.mock.calls[0]?.[0].filters).toMatchObject({
      categories: { documentId: 'cat-1' },
    });
    expect(response.data.dealsByCategory.tabs[0].deals).toHaveLength(10);
    expect(response.data.dealsByCategory.tabs[0].deals[0].documentId).toBe('deal-20');
  });

  it('does not activate category fallback when all selected Deals are unusable', async () => {
    const harness = createHarness(
      {
        dealsByCategory: {
          enabled: true,
          tabs: [
            {
              category: { documentId: 'cat-1' },
              deals: [actionableDeal(1, { dealImage: null })],
            },
          ],
        },
      },
      [actionableDeal(20)],
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.dealsByCategory.tabs[0].deals).toEqual([]);
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('keeps selected store Deals exclusive and preserves their order', async () => {
    const harness = createHarness(
      {
        dealsByStore: {
          enabled: true,
          tabs: [
            {
              store: { documentId: 'store-1' },
              deals: [actionableDeal(8), actionableDeal(2)],
            },
          ],
        },
      },
      Array.from({ length: 12 }, (_, index) => actionableDeal(index + 20)),
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(
      response.data.dealsByStore.tabs[0].deals.map((deal: any) => deal.documentId),
    ).toEqual(['deal-8', 'deal-2']);
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('queries store membership only when no store Deals are selected', async () => {
    const fallback = Array.from({ length: 12 }, (_, index) => actionableDeal(index + 20));
    const harness = createHarness(
      {
        dealsByStore: {
          enabled: true,
          tabs: [{ store: { documentId: 'store-1' }, deals: [] }],
        },
      },
      fallback,
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(harness.findManyDeals).toHaveBeenCalledTimes(1);
    // Store membership is the `stores` taxonomy alone since `primaryStore`
    // was removed — no $or arm needed.
    expect(harness.findManyDeals.mock.calls[0]?.[0].filters).toMatchObject({
      stores: { documentId: 'store-1' },
    });
    expect(response.data.dealsByStore.tabs[0].deals).toHaveLength(10);
  });

  it('does not activate store fallback when all selected Deals are unusable', async () => {
    const harness = createHarness(
      {
        dealsByStore: {
          enabled: true,
          tabs: [
            {
              store: { documentId: 'store-1' },
              deals: [actionableDeal(1, { affiliateLink: 'javascript:alert(1)' })],
            },
          ],
        },
      },
      [actionableDeal(20)],
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.dealsByStore.tabs[0].deals).toEqual([]);
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('marks selected All Deals as curated and never merges a catalog fallback', async () => {
    const harness = createHarness(
      {
        allDeals: {
          enabled: true,
          deals: [actionableDeal(7), actionableDeal(3)],
        },
      },
      [actionableDeal(20)],
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.allDeals.source).toBe('curated');
    expect(response.data.allDeals.deals.map((deal: any) => deal.documentId)).toEqual([
      'deal-7',
      'deal-3',
    ]);
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('marks an empty All Deals relation for catalog fallback', async () => {
    const harness = createHarness({
      allDeals: { enabled: true, deals: [] },
    });

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.allDeals).toMatchObject({ source: 'catalog', deals: [] });
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('keeps All Deals curated when every selected Deal becomes unusable', async () => {
    const harness = createHarness(
      {
        allDeals: {
          enabled: true,
          deals: [actionableDeal(1, { dealImage: null })],
        },
      },
      [actionableDeal(20)],
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.allDeals).toMatchObject({ source: 'curated', deals: [] });
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('ships an empty Smart Stack when no curated deal carries both benefit texts', async () => {
    const harness = createHarness(
      {
        smartSavingStack: {
          enabled: true,
          deals: [actionableDeal(1), actionableDeal(2), actionableDeal(3)],
        },
      },
      [actionableDeal(10), actionableDeal(11)],
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.smartSavingStack.deals).toEqual([]);
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('backfills sections whose enabled flag is missing (legacy entries)', async () => {
    // Only an explicit `enabled: false` disables a section on the site —
    // entries saved without the flag must still get their fallback deals.
    const harness = createHarness(
      { topDeals: { deals: [actionableDeal(1)] } },
      Array.from({ length: 12 }, (_, index) => actionableDeal(index + 5)),
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(harness.findManyDeals).toHaveBeenCalledTimes(1);
    expect(response.data.topDeals.deals).toHaveLength(10);
  });

  it('skips backfill and deal counts for explicitly disabled sections', async () => {
    const harness = createHarness({
      topDeals: { enabled: false, deals: [actionableDeal(1), publishedDeal(2)] },
      dealsByCategory: {
        enabled: false,
        tabs: [{ category: { documentId: 'cat-1' }, deals: [actionableDeal(3)] }],
      },
      smartSavingStack: { enabled: false, deals: [benefitDeal(4)] },
    });

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(harness.findManyDeals).not.toHaveBeenCalled();
    // Disabled sections keep their curated (live) deals untouched and get no
    // computed counts — only the catalog-wide total is attached.
    expect(response.data.topDeals.deals).toHaveLength(2);
    expect(response.data.dealsByCategory.tabs[0]).not.toHaveProperty('dealCount');
    expect(response.data.smartSavingStack).not.toHaveProperty('totalCount');
    expect(response.data).toHaveProperty('totalDealCount');
  });

  it('preserves curated Smart Stack order and enforces the benefit-text rule', async () => {
    const harness = createHarness(
      {
        smartSavingStack: {
          enabled: true,
          deals: [benefitDeal(1), actionableDeal(2), benefitDeal(3, { cashbackText: ' ' })],
        },
      },
      [benefitDeal(10), actionableDeal(11), benefitDeal(12)],
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(
      response.data.smartSavingStack.deals.map((deal: any) => deal.documentId),
    ).toEqual(['deal-1']);
    expect(harness.findManyDeals).not.toHaveBeenCalled();
  });

  it('returns every Smart Stack selection in authored order with no cap', async () => {
    const authored = [8, 3, 11, 2, 7, 1, 9, 4].map(benefitDeal);
    const harness = createHarness({
      smartSavingStack: {
        enabled: true,
        deals: authored,
      },
    });

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(
      response.data.smartSavingStack.deals.map((deal: any) => deal.documentId),
    ).toEqual(authored.map((deal) => deal.documentId));
    expect(response.data.smartSavingStack.deals).toHaveLength(8);
  });

  it('attaches computed deal counts for tabs, the smart stack, and the whole catalog', async () => {
    const harness = createHarness(
      {
        dealsByCategory: {
          tabs: [
            {
              category: { documentId: 'cat-1' },
              deals: Array.from({ length: 6 }, (_, i) => actionableDeal(i)),
            },
          ],
        },
        dealsByStore: {
          tabs: [
            {
              store: { documentId: 'store-1' },
              deals: Array.from({ length: 6 }, (_, i) => actionableDeal(i + 10)),
            },
          ],
        },
        smartSavingStack: {
          deals: Array.from({ length: 6 }, (_, i) => benefitDeal(i + 20)),
        },
      },
      [],
      (args: any) => {
        const filters = JSON.stringify(args?.filters ?? {});
        if (filters.includes('cat-1')) return 28;
        if (filters.includes('store-1')) return 17;
        if (filters.includes('cashbackText')) return 9;
        return 214;
      },
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(response.data.dealsByCategory.tabs[0].dealCount).toBe(28);
    expect(response.data.dealsByStore.tabs[0].dealCount).toBe(17);
    expect(response.data.smartSavingStack.totalCount).toBe(9);
    expect(response.data.totalDealCount).toBe(214);
  });
});
