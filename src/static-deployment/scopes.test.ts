import { describe, expect, it, vi } from 'vitest';
import { preDeleteScope } from './scopes';

function strapiWithFindOne(findOne: (args: any) => Promise<any>) {
  return {
    documents: () => ({ findOne }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;
}

describe('preDeleteScope failure escalation', () => {
  it('returns the related-page scope when the pre-read succeeds', async () => {
    const strapi = strapiWithFindOne(async () => ({
      stores: [{ slug: 'amazon' }],
      brands: [],
      categories: [],
      banks: [],
    }));
    await expect(
      preDeleteScope(strapi, 'api::coupon.coupon', 'doc1', 'update'),
    ).resolves.toEqual({ slugs: ['amazon'], homepage: true });
  });

  it('escalates to full when a DELETE pre-read fails (relations unknowable afterwards)', async () => {
    const strapi = strapiWithFindOne(async () => {
      throw new Error('db hiccup');
    });
    await expect(
      preDeleteScope(strapi, 'api::deal.deal', 'doc1', 'delete'),
    ).resolves.toEqual({ full: true });
  });

  it('does NOT escalate an UPDATE pre-read failure to full — computeScope still covers after-relations', async () => {
    const strapi = strapiWithFindOne(async () => {
      throw new Error('db hiccup');
    });
    await expect(
      preDeleteScope(strapi, 'api::coupon.coupon', 'doc1', 'update'),
    ).resolves.toBeNull();
    expect(strapi.log.warn).toHaveBeenCalled();
  });

  it('treats a vanished doc the same way: full for delete, null otherwise', async () => {
    const strapi = strapiWithFindOne(async () => null);
    await expect(
      preDeleteScope(strapi, 'api::coupon.coupon', 'doc1', 'delete'),
    ).resolves.toEqual({ full: true });
    await expect(
      preDeleteScope(strapi, 'api::coupon.coupon', 'doc1', 'publish'),
    ).resolves.toBeNull();
  });

  it('ignores non-offer content types', async () => {
    const strapi = strapiWithFindOne(async () => {
      throw new Error('must not be called');
    });
    await expect(
      preDeleteScope(strapi, 'api::store.store', 'doc1', 'delete'),
    ).resolves.toBeNull();
  });
});
