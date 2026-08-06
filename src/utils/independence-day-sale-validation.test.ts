import { describe, expect, it, vi } from 'vitest';
import { validateIndependenceDaySale } from './independence-day-sale-validation';

function strapiWithCurrent(current: any = {}) {
  const findOne = vi.fn().mockResolvedValue(current);
  return {
    strapi: {
      db: { query: vi.fn(() => ({ findOne })) },
    } as any,
    findOne,
  };
}

const countdown = {
  enabled: true,
  saleStartAt: '2026-08-01T00:00:00.000Z',
  saleEndAt: '2026-08-15T23:59:59.000Z',
};

describe('Independence Day sale validation', () => {
  it('accepts a valid sale window and every fixed authoring cap', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateIndependenceDaySale(strapi, {
        countdown,
        topPicks: { offers: Array.from({ length: 4 }, (_, id) => ({ id })) },
        couponsByCategory: {
          tabs: Array.from({ length: 4 }, () => ({
            offers: Array.from({ length: 10 }, (_, id) => ({ id })),
          })),
        },
        allCoupons: {
          offers: Array.from({ length: 100 }, (_, id) => ({ id })),
        },
        allDeals: {
          deals: Array.from({ length: 100 }, (_, id) => ({ id })),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an All Coupons or All Deals relation above 100 items', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateIndependenceDaySale(strapi, {
        countdown,
        allCoupons: {
          offers: Array.from({ length: 101 }, (_, id) => ({ id })),
        },
      }),
    ).rejects.toMatchObject({
      details: { errors: [{ path: ['allCoupons', 'offers'] }] },
    });
  });

  it('rejects a fifth Explore by Category tab', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateIndependenceDaySale(strapi, {
        countdown,
        couponsByCategory: {
          tabs: Array.from({ length: 5 }, () => ({ offers: [] })),
        },
      }),
    ).rejects.toMatchObject({
      details: { errors: [{ path: ['couponsByCategory', 'tabs'] }] },
    });
  });

  it('rejects an inverted sale window with the countdown field path', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateIndependenceDaySale(strapi, {
        countdown: {
          saleStartAt: countdown.saleEndAt,
          saleEndAt: countdown.saleStartAt,
        },
      }),
    ).rejects.toMatchObject({
      details: { errors: [{ path: ['countdown'] }] },
    });
  });

  it('accepts a disabled countdown without dates', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateIndependenceDaySale(strapi, {
        countdown: { enabled: false },
      }),
    ).resolves.toBeUndefined();
  });

  it('counts nested tab connect/disconnect updates against the saved relation', async () => {
    const savedOffers = Array.from({ length: 10 }, (_, id) => ({ id: id + 1 }));
    const { strapi } = strapiWithCurrent({
      countdown,
      couponsByStore: { tabs: [{ id: 7, offers: savedOffers }] },
    });

    await expect(
      validateIndependenceDaySale(strapi, {
        couponsByStore: {
          tabs: [
            {
              id: 7,
              offers: { disconnect: [{ id: 1 }], connect: [{ id: 99 }, { id: 100 }] },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      details: {
        errors: [
          { path: ['couponsByStore', 'tabs', '0', 'offers'] },
        ],
      },
    });
  });
});
