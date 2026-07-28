import { describe, expect, it } from 'vitest';

import { orderPreviewSourceFromResponse } from './order-preview-response';

describe('Coupon layout preview response', () => {
  it('reads the full membership total from the top-level field', () => {
    const source = orderPreviewSourceFromResponse(
      {
        coupons: [
          {
            id: 1,
            documentId: 'coupon-1',
            title: 'First Coupon',
            couponType: 'generic',
          },
        ],
        total: 237,
      },
      [],
    );

    expect(source.total).toBe(237);
    expect(source.sequence.map((coupon) => coupon.documentId)).toEqual([
      'coupon-1',
    ]);
  });
});
