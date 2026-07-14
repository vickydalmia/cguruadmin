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
  it('filters, sorts, and bounds Coupon and Deal relations at query time', async () => {
    const harness = createHarness({});

    await harness.controller.homepageFull(harness.ctx as any);

    const options = harness.findFirst.mock.calls[0]?.[0];
    const populate = options.populate;
    const boundedPublishedRelation = {
      filters: { contentStatus: { $eq: 'published' } },
      sort: ['publishedAt:desc'],
      limit: 16,
    };

    expect(populate.topDeals.populate.deals).toMatchObject(boundedPublishedRelation);
    expect(populate.dealsByBrand.populate.deals).toMatchObject(boundedPublishedRelation);
    expect(populate.exploreDeals.populate.tabs.populate.deals).toMatchObject(
      boundedPublishedRelation,
    );
    expect(populate.offersByBrand.populate.offers).toMatchObject(boundedPublishedRelation);
    expect(populate.exploreOffers.populate.tabs.populate.offers).toMatchObject(
      boundedPublishedRelation,
    );
    expect(populate.hero.populate.products.populate.deal.filters).toEqual(
      boundedPublishedRelation.filters,
    );
    expect(populate.topOffers.populate.items.populate.coupon.filters).toEqual(
      boundedPublishedRelation.filters,
    );
  });

  it('still removes unpublished rows and caps populated lists defensively', async () => {
    const published = Array.from({ length: 17 }, (_, index) => publishedOffer(index));
    const expired = { documentId: 'expired', contentStatus: 'expired' };
    const harness = createHarness({
      topDeals: { deals: [expired, ...published] },
      offersByBrand: { offers: [expired, ...published] },
      exploreDeals: { tabs: [{ deals: [expired, ...published] }] },
      exploreOffers: { tabs: [{ offers: [expired, ...published] }] },
    });

    const response = await harness.controller.homepageFull(harness.ctx as any);

    expect(response.data.topDeals.deals).toHaveLength(16);
    expect(response.data.offersByBrand.offers).toHaveLength(16);
    expect(response.data.exploreDeals.tabs[0].deals).toHaveLength(16);
    expect(response.data.exploreOffers.tabs[0].offers).toHaveLength(16);
    expect(JSON.stringify(response.data)).not.toContain('expired');
  });
});
