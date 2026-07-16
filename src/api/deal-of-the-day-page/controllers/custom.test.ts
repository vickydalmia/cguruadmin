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

    expect(populate.dealsByCategory.populate.tabs.populate.category.fields).toEqual([
      'name',
      'slug',
    ]);
    expect(populate.dealsByStore.populate.tabs.populate.store.fields).toEqual([
      'name',
      'slug',
      'logoAlt',
    ]);
  });

  it('filters and sorts every Deal relation with Document Service-compatible keys', async () => {
    const harness = createHarness({});

    await harness.controller.dealOfTheDayFull(harness.ctx as any);

    const populate = harness.findFirst.mock.calls[0]?.[0].populate;
    const publishedRelation = {
      filters: { contentStatus: { $eq: 'published' } },
      sort: ['publishedAt:desc'],
    };

    for (const ref of [
      populate.topPicks.populate.deals,
      populate.topDeals.populate.deals,
      populate.dealsByCategory.populate.tabs.populate.deals,
      populate.dealsByStore.populate.tabs.populate.deals,
      populate.smartSavingStack.populate.deals,
      populate.trendingNow.populate.deals,
      populate.genZDrops.populate.deals,
      populate.telegramDeals.populate.deals,
    ]) {
      expect(ref).toMatchObject(publishedRelation);
      expect(ref).not.toHaveProperty('limit');
      expect(ref).not.toHaveProperty('pagination');
    }
  });

  it('removes dead rows and caps each list at its own buffer', async () => {
    const published = Array.from({ length: 30 }, (_, index) => publishedDeal(index));
    const expired = { documentId: 'expired', contentStatus: 'expired' };
    const harness = createHarness({
      topPicks: { deals: [expired, ...published] },
      smartSavingStack: { enabled: false, deals: [expired, ...published] },
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
    expect(response.data.smartSavingStack.deals).toHaveLength(6);
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

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(
      response.data.topDeals.deals.map((deal: any) => deal.documentId),
    ).toEqual([
      'deal-1',
      'deal-5',
      'deal-6',
      'deal-7',
      'deal-8',
      'deal-9',
      'deal-10',
      'deal-11',
      'deal-12',
      'deal-13',
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

  it('backfills category tabs by category membership and store tabs by store membership', async () => {
    const harness = createHarness(
      {
        dealsByCategory: {
          enabled: true,
          tabs: [{ category: { documentId: 'cat-1' }, deals: [actionableDeal(1)] }],
        },
        dealsByStore: {
          enabled: true,
          tabs: [{ store: { documentId: 'store-1' }, deals: [] }],
        },
      },
      Array.from({ length: 12 }, (_, index) => actionableDeal(index + 20)),
    );

    const response = await harness.controller.dealOfTheDayFull(harness.ctx as any);

    expect(harness.findManyDeals).toHaveBeenCalledTimes(2);
    expect(harness.findManyDeals.mock.calls[0]?.[0].filters).toMatchObject({
      categories: { documentId: 'cat-1' },
    });
    expect(harness.findManyDeals.mock.calls[1]?.[0].filters).toMatchObject({
      $or: [
        { stores: { documentId: 'store-1' } },
        { primaryStore: { documentId: 'store-1' } },
      ],
    });
    expect(response.data.dealsByCategory.tabs[0].deals).toHaveLength(10);
    expect(response.data.dealsByCategory.tabs[0].deals[0].documentId).toBe('deal-1');
    expect(response.data.dealsByStore.tabs[0].deals).toHaveLength(10);
  });

  it('ships an empty Smart Stack when no curated or catalog deal carries both benefit texts', async () => {
    // The live failure mode: editors curate deals without benefit texts and
    // the whole catalog has none either — the section must degrade to an
    // empty list (frontend shows its designed empty state), never throw.
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
    expect(harness.findManyDeals).toHaveBeenCalledTimes(1);
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

  it('enforces the benefit-text rule on curated and backfilled Smart Stack deals', async () => {
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
    ).toEqual(['deal-1', 'deal-10', 'deal-12']);
    expect(harness.findManyDeals.mock.calls[0]?.[0].filters).toMatchObject({
      cashbackText: { $notNull: true, $ne: '' },
      bankOfferText: { $notNull: true, $ne: '' },
    });
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
