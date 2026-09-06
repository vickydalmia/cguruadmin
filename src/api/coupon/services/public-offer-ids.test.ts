import { afterEach, describe, expect, it, vi } from 'vitest';
import { setEnabledContentLocaleCodesForTest } from '../../../translation/locales/registry';
import {
  attachStablePublicOfferIds,
  attachStablePublicOfferIdsForRequest,
} from './public-offer-ids';

afterEach(() => {
  setEnabledContentLocaleCodesForTest([]);
});

function harness(coupons: any[] = [], deals: any[] = []) {
  const couponFindMany = vi.fn().mockResolvedValue(coupons);
  const dealFindMany = vi.fn().mockResolvedValue(deals);
  const query = vi.fn((uid: string) => ({
    findMany:
      uid === 'api::coupon.coupon' ? couponFindMany : dealFindMany,
  }));
  return {
    strapi: { db: { query } } as any,
    query,
    couponFindMany,
    dealFindMany,
  };
}

describe('stable public offer ids', () => {
  it('rewrites nested translated Coupon and Product Deal ids to their English route ids', async () => {
    const db = harness(
      [{ id: 11, documentId: 'coupon-1' }],
      [{ id: 22, documentId: 'deal-1' }],
    );
    const payload = {
      data: {
        coupon: { id: 101, documentId: 'coupon-1', title: 'قسيمة' },
        nested: [{ deal: { id: 202, documentId: 'deal-1', title: 'صفقة' } }],
        store: { id: 303, documentId: 'store-1', name: 'متجر' },
      },
    };

    await attachStablePublicOfferIds(db.strapi, payload, 'ar');

    expect(payload.data.coupon.id).toBe(11);
    expect(payload.data.nested[0]?.deal.id).toBe(22);
    expect(payload.data.store.id).toBe(303);
    expect(db.couponFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          locale: 'en',
          documentId: {
            $in: expect.arrayContaining(['coupon-1', 'deal-1', 'store-1']),
          },
        },
        select: ['id', 'documentId'],
      }),
    );
  });

  it('does no database work for English or an unsupported request locale', async () => {
    const db = harness([{ id: 11, documentId: 'coupon-1' }]);
    const payload = { id: 101, documentId: 'coupon-1' };

    await attachStablePublicOfferIds(db.strapi, payload, 'en');
    await attachStablePublicOfferIdsForRequest(
      db.strapi,
      { query: { locale: 'fr' } },
      payload,
    );

    expect(payload.id).toBe(101);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('normalizes only locale codes enabled for the deployment', async () => {
    setEnabledContentLocaleCodesForTest(['ar']);
    const db = harness([{ id: 11, documentId: 'coupon-1' }]);
    const payload = { id: 101, documentId: 'coupon-1' };

    await attachStablePublicOfferIdsForRequest(
      db.strapi,
      { query: { locale: 'ar' } },
      payload,
    );

    expect(payload.id).toBe(11);
  });

  it('fails closed instead of guessing when a documentId collides across offer types', async () => {
    const db = harness(
      [{ id: 11, documentId: 'legacy-collision' }],
      [{ id: 22, documentId: 'legacy-collision' }],
    );
    const payload = { id: 999, documentId: 'legacy-collision' };

    await attachStablePublicOfferIds(db.strapi, payload, 'ar');

    expect(payload.id).toBe(999);
  });
});
