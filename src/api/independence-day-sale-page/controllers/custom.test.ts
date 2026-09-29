import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import createIndependenceDaySaleController from './custom';
import { COUPON_FIELDS } from './independence-day-sale-populate';
import { setEnabledContentLocaleCodesForTest } from '../../../translation/locales/registry';
import {
  fillAllCouponHolder,
  fillAllDealHolder,
} from './independence-day-sale-transforms';

const NOW = new Date('2026-08-06T12:00:00.000Z');

function coupon(documentId: string, overrides: Record<string, unknown> = {}) {
  return {
    documentId,
    contentStatus: 'published',
    title: `Coupon ${documentId}`,
    affiliateLink: `https://example.com/${documentId}`,
    stores: [{ name: 'Store', logo: { url: '/store.svg' } }],
    ...overrides,
  };
}

function deal(documentId: string, overrides: Record<string, unknown> = {}) {
  return {
    documentId,
    contentStatus: 'published',
    affiliateLink: `https://example.com/${documentId}`,
    dealImage: { url: '/deal.webp' },
    ...overrides,
  };
}

function strapiWithCatalog(coupons: any[] = [], deals: any[] = []) {
  const couponFindMany = vi.fn(async ({ start = 0, limit = 100 }: any) =>
    coupons.slice(start, start + limit),
  );
  const dealFindMany = vi.fn(async ({ start = 0, limit = 100 }: any) =>
    deals.slice(start, start + limit),
  );
  const strapi = {
    documents: vi.fn((uid: string) => ({
      findMany:
        uid === 'api::coupon.coupon' ? couponFindMany : dealFindMany,
    })),
    contentType: vi.fn(() => ({})),
    contentAPI: {
      sanitize: { output: vi.fn(async (rows: any) => rows) },
    },
  } as any;
  return { strapi, couponFindMany, dealFindMany };
}

describe('Independence Day sale Coupon projection', () => {
  it('requests only fields supported by the Coupon schema', () => {
    const schemaPath = path.join(
      process.cwd(),
      'src/api/coupon/content-types/coupon/schema.json',
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      attributes: Record<string, unknown>;
    };
    const systemFields = new Set(['createdAt', 'updatedAt', 'publishedAt']);

    expect(
      COUPON_FIELDS.filter(
        (field) => !(field in schema.attributes) && !systemFields.has(field),
      ),
    ).toEqual([]);
  });
});

describe('Independence Day sale All Coupons and All Deals policy', () => {
  it('uses selected Coupons in editor order without catalog backfill', async () => {
    const selected = [
      coupon('selected-2'),
      coupon('expired', { expiresAt: '2026-08-01T00:00:00.000Z' }),
      coupon('selected-1'),
    ];
    const holder = { offers: selected };
    const { strapi, couponFindMany } = strapiWithCatalog([
      coupon('catalog-1'),
    ]);

    await fillAllCouponHolder(strapi, { state: {} }, holder, 100, NOW);

    expect(holder.offers.map((item) => item.documentId)).toEqual([
      'selected-2',
      'selected-1',
    ]);
    expect(couponFindMany).not.toHaveBeenCalled();
  });

  it('does not backfill when every selected Deal is invalid', async () => {
    const holder = {
      deals: [deal('invalid', { affiliateLink: 'javascript:alert(1)' })],
    };
    const { strapi, dealFindMany } = strapiWithCatalog([deal('catalog-1')]);

    await fillAllDealHolder(strapi, { state: {} }, holder, 100, NOW);

    expect(holder.deals).toEqual([]);
    expect(dealFindMany).not.toHaveBeenCalled();
  });

  it('collects the latest 100 actionable Coupons sitewide across query batches', async () => {
    const firstBatch = Array.from({ length: 100 }, (_, index) =>
      index < 10
        ? coupon(`invalid-${index}`, { affiliateLink: '' })
        : coupon(`coupon-${index}`),
    );
    const secondBatch = Array.from({ length: 20 }, (_, index) =>
      coupon(`coupon-${index + 100}`),
    );
    const holder = { offers: [] };
    const { strapi, couponFindMany } = strapiWithCatalog([
      ...firstBatch,
      ...secondBatch,
    ]);

    await fillAllCouponHolder(strapi, { state: {} }, holder, 100, NOW);

    expect(holder.offers).toHaveLength(100);
    expect(holder.offers[0].documentId).toBe('coupon-10');
    expect(holder.offers.at(-1)?.documentId).toBe('coupon-109');
    expect(couponFindMany).toHaveBeenCalledTimes(2);
    expect(couponFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        filters: { contentStatus: { $eq: 'published' } },
        sort: ['publishedOn:desc', 'publishedAt:desc'],
        start: 0,
        limit: 100,
      }),
    );
    expect(couponFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ start: 100, limit: 100 }),
    );
  });
});

describe('independenceDaySaleFull locale', () => {
  function harness() {
    const findFirst = vi.fn(async () => null);
    const strapi = {
      documents: vi.fn(() => ({ findFirst })),
      contentType: vi.fn(() => ({})),
      contentAPI: { sanitize: { output: vi.fn(async (rows: any) => rows) } },
    } as any;
    const ctx = { state: { auth: null }, notFound: vi.fn(() => 'not-found'), send: vi.fn() };
    return { controller: createIndependenceDaySaleController({ strapi }), ctx, findFirst };
  }

  it('reads the requested enabled locale and falls back to English otherwise', async () => {
    setEnabledContentLocaleCodesForTest(['ar']);
    try {
      const localized = harness();
      await localized.controller.independenceDaySaleFull({ ...localized.ctx, query: { locale: 'ar' } });
      expect(localized.findFirst.mock.calls[0]?.[0]).toMatchObject({ locale: 'ar' });

      const unknown = harness();
      await unknown.controller.independenceDaySaleFull({ ...unknown.ctx, query: { locale: 'zz' } });
      expect(unknown.findFirst.mock.calls[0]?.[0]).toMatchObject({ locale: 'en' });
      expect(unknown.ctx.notFound).toHaveBeenCalledWith('Independence Day sale page not found');
    } finally {
      setEnabledContentLocaleCodesForTest([]);
    }
  });
});
