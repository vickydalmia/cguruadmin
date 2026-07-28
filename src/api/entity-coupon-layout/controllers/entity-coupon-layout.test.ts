import { describe, expect, it, vi } from 'vitest';

import createController, {
  isCouponLayoutSuperAdmin,
} from './entity-coupon-layout';

describe('entity Coupon layout Super Admin capability', () => {
  it('recognizes the persisted Super Admin role independently of userAbility', async () => {
    const findOne = vi.fn().mockResolvedValue({
      roles: [{ code: 'strapi-super-admin' }],
    });
    const strapi = {
      db: { query: vi.fn(() => ({ findOne })) },
    } as any;

    await expect(
      isCouponLayoutSuperAdmin(strapi, {
        state: { user: { id: 7 }, userAbility: { can: () => false } },
      }),
    ).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledWith({
      where: { id: 7 },
      populate: { roles: { select: ['code'] } },
    });
  });

  it('does not elevate Editors or malformed sessions', async () => {
    const findOne = vi.fn().mockResolvedValue({
      roles: [{ code: 'strapi-editor' }],
    });
    const strapi = {
      db: { query: vi.fn(() => ({ findOne })) },
    } as any;

    await expect(
      isCouponLayoutSuperAdmin(strapi, { state: { user: { id: 9 } } }),
    ).resolves.toBe(false);
    await expect(
      isCouponLayoutSuperAdmin(strapi, { state: { user: undefined } }),
    ).resolves.toBe(false);
  });

  it('keeps capabilities in the successful save response', async () => {
    const replace = vi.fn().mockResolvedValue({
      version: '2026-07-29T00:00:00.000Z',
      topPickCoupons: [],
      orderedCoupons: [],
      counts: { topPicks: 0, ordered: 0 },
      refresh: { outboxId: '41', state: 'queued' },
    });
    const strapi = {
      db: {
        query: vi.fn((uid: string) => {
          if (uid === 'admin::user') {
            return {
              findOne: vi.fn().mockResolvedValue({
                roles: [{ code: 'strapi-super-admin' }],
              }),
            };
          }
          throw new Error(`unexpected query ${uid}`);
        }),
      },
      service: vi.fn(() => ({ replace })),
    } as any;
    const send = vi.fn();
    const ctx = {
      state: { user: { id: 7 }, userAbility: { can: () => false } },
      params: { kind: 'store', documentId: 'store-1' },
      request: {
        body: {
          data: {
            version: 'old',
            topPickCouponIds: [],
            orderedCouponIds: [],
          },
        },
      },
      send,
      forbidden: vi.fn(),
    };

    await createController({ strapi }).replace(ctx);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: {
          canRead: true,
          canUpdate: true,
          canManageLayout: true,
          reason: null,
        },
      }),
    );
  });
});
