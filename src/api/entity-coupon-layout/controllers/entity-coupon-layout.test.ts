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

describe('refresh endpoint authorization', () => {
  function ctxFor(roleCode: string, can = () => false) {
    const first = vi.fn().mockResolvedValue({
      id: 41,
      status: 'pending',
      attempt_count: 0,
      last_error: 'internal detail',
      delivery_receipt: JSON.stringify({ paths: [{ path: '/a/', version: 1 }] }),
      accepted_at: null,
      delivered_at: null,
    });
    const connection = vi.fn(() => ({
      where: vi.fn(() => ({ select: vi.fn(() => ({ first })) })),
    }));
    const strapi = {
      db: {
        connection,
        query: vi.fn(() => ({
          findOne: vi.fn().mockResolvedValue({ roles: [{ code: roleCode }] }),
        })),
      },
    } as any;
    const ctx = {
      state: { user: { id: 7 }, userAbility: { can } },
      params: { outboxId: '41' },
      send: vi.fn(),
      forbidden: vi.fn(),
      badRequest: vi.fn(),
      notFound: vi.fn(),
    };
    return { strapi, ctx, first };
  }

  // outboxId is a bare incrementing integer, so without a capability check any
  // admin of any role could walk the whole outbox.
  it('rejects an admin without the layout capability', async () => {
    const { strapi, ctx, first } = ctxFor('strapi-author');

    await createController({ strapi }).refresh(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
    // Denied before the row is ever read.
    expect(first).not.toHaveBeenCalled();
  });

  it('allows a Super Admin but returns no outbox internals', async () => {
    const { strapi, ctx } = ctxFor('strapi-super-admin');

    await createController({ strapi }).refresh(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
    const payload = ctx.send.mock.calls[0][0];
    expect(payload).toMatchObject({ outboxId: '41', state: 'queued' });
    expect(payload).not.toHaveProperty('error');
    expect(payload).not.toHaveProperty('receipt');
    expect(JSON.stringify(payload)).not.toContain('internal detail');
  });

  it('allows a non-Super-Admin holding the layout action', async () => {
    const { strapi, ctx } = ctxFor('strapi-editor', () => true);

    await createController({ strapi }).refresh(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalled();
  });
});
