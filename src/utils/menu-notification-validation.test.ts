import { describe, expect, it, vi } from 'vitest';

import { validateMenuNotification } from './menu-notification-validation';

function harness({
  stored = null,
  files = [],
}: {
  stored?: Record<string, unknown> | null;
  files?: Record<string, unknown>[];
} = {}) {
  const findOne = vi.fn().mockResolvedValue(stored);
  const findMany = vi.fn().mockResolvedValue(files);
  return {
    strapi: {
      documents: vi.fn(() => ({ findOne })),
      db: {
        query: vi.fn((uid: string) => {
          if (uid !== 'plugin::upload.file') {
            throw new Error(`Unexpected query: ${uid}`);
          }
          return { findMany };
        }),
      },
    } as any,
    findOne,
    findMany,
  };
}

describe('menu notification validation', () => {
  it('accepts multiple independent Coupon and Product Deal rows', async () => {
    const { strapi } = harness();
    await expect(
      validateMenuNotification(strapi, {
        notification: {
          coupon: [
            { coupon: { connect: [{ documentId: 'coupon-1' }] } },
            { coupon: { connect: [{ documentId: 'coupon-2' }] } },
          ],
          productDeal: [
            { productDeal: { connect: [{ documentId: 'deal-1' }] } },
            { productDeal: { connect: [{ documentId: 'deal-2' }] } },
          ],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('requires the matching relation when an override is entered', async () => {
    const { strapi } = harness();
    const error = await validateMenuNotification(strapi, {
      notification: {
        coupon: [
          {
            coupon: null,
            titleOverride: 'Weekend Coupon',
          },
        ],
        productDeal: [
          {
            productDeal: null,
            titleOverride: 'Laptop Deal',
          },
        ],
      },
    }).catch((value) => value);

    expect(
      error.details.errors.map((entry: any) => entry.path.join('.')),
    ).toEqual([
      'notification.coupon.0.coupon',
      'notification.productDeal.0.productDeal',
    ]);
  });

  it('accepts an image up to 80×80 px and rejects a larger override', async () => {
    const accepted = harness({
      files: [{ id: 8, name: 'coupon.webp', width: 80, height: 64 }],
    });
    await expect(
      validateMenuNotification(accepted.strapi, {
        notification: {
          coupon: [
            {
              coupon: { documentId: 'coupon-1' },
              imageOverride: { id: 8 },
            },
          ],
        },
      }),
    ).resolves.toBeUndefined();

    const rejected = harness({
      files: [{ id: 9, name: 'deal.webp', width: 81, height: 80 }],
    });
    const error = await validateMenuNotification(rejected.strapi, {
      notification: {
        productDeal: [
          {
            productDeal: { documentId: 'deal-1' },
            imageOverride: { id: 9 },
          },
        ],
      },
    }).catch((value) => value);
    expect(error.details.errors[0]).toMatchObject({
      path: ['notification', 'productDeal', 0, 'imageOverride'],
      message: expect.stringContaining(
        '"deal.webp" is 81×80 px',
      ),
    });
  });

  it('preserves untouched stored component fields during a partial update', async () => {
    const { strapi, findOne } = harness({
      stored: {
        notification: {
          id: 1,
          coupon: [
            {
              id: 2,
              coupon: { documentId: 'coupon-1' },
              imageOverride: { id: 7 },
            },
          ],
        },
      },
      files: [{ id: 7, name: 'stored.webp', width: 80, height: 80 }],
    });

    await expect(
      validateMenuNotification(
        strapi,
        {
          notification: {
            id: 1,
            coupon: [
              {
                id: 2,
                titleOverride: 'Updated title',
              },
            ],
          },
        },
        'menu-1',
      ),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'menu-1' }),
    );
  });
});
