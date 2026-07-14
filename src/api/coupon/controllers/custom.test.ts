import { describe, expect, it, vi } from 'vitest';

import createCouponController from './custom';

function createHarness() {
  const dealFindMany = vi.fn().mockResolvedValue([]);
  const dealCount = vi.fn().mockResolvedValue(0);
  const entityFindMany = vi.fn().mockResolvedValue([
    {
      documentId: 'store-amazon',
      name: 'Amazon',
      slug: 'amazon-coupons',
    },
  ]);
  const documents = vi.fn((uid: string) => {
    if (uid === 'api::deal.deal') {
      return { findMany: dealFindMany, count: dealCount };
    }
    return { findMany: entityFindMany, count: vi.fn().mockResolvedValue(0) };
  });
  const sanitizeQuery = vi.fn(async (query: any) => query);
  const strapi = {
    documents,
    contentType: vi.fn(() => ({})),
    contentAPI: {
      validate: { query: vi.fn(async () => undefined) },
      sanitize: {
        query: sanitizeQuery,
        output: vi.fn(async (data: any) => data),
      },
    },
  } as any;
  const ctx = {
    params: { slug: 'amazon-coupons' },
    query: { page: '1', pageSize: '20' },
    state: { auth: null, entityType: 'store' },
    notFound: vi.fn(),
    send: vi.fn((payload: any) => payload),
  };

  return {
    controller: createCouponController({ strapi }),
    ctx,
    dealFindMany,
  };
}

describe('entity product Deal population', () => {
  it('populates nested owner logos for the shared Deal card', async () => {
    const harness = createHarness();

    await harness.controller.getDealsByEntity(harness.ctx as any);

    const options = harness.dealFindMany.mock.calls[0]?.[0];
    const logoRef = {
      fields: ['name', 'slug', 'logoAlt'],
      populate: { logo: true },
    };
    expect(options.populate.primaryStore).toEqual(logoRef);
    expect(options.populate.stores).toEqual(logoRef);
    expect(options.populate.brands).toEqual(logoRef);
    expect(options.populate.banks).toEqual(logoRef);
    expect(options.populate.categories).toEqual({
      fields: ['name', 'slug'],
      populate: { icon: true },
    });
  });
});
