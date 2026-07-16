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

describe('deal-of-the-day landing page scope', () => {
  const relationDoc = {
    stores: [{ slug: 'amazon' }],
    brands: [],
    categories: [],
    banks: [],
  };

  it('rebuilds only the landing page when the single type changes', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => {
      throw new Error('must not be called');
    });
    await expect(
      computeScope(
        strapi,
        'api::deal-of-the-day-page.deal-of-the-day-page',
        'update',
        'doc1',
      ),
    ).resolves.toEqual({ slugs: ['deal-of-the-day'] });
  });

  it('appends the landing slug to every Deal change scope', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => relationDoc);
    await expect(
      computeScope(strapi, 'api::deal.deal', 'update', 'doc1'),
    ).resolves.toEqual({ slugs: ['amazon', 'deal-of-the-day'], homepage: true });
  });

  it('covers curated-only Deals that have no entity relations', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({
      stores: [],
      brands: [],
      categories: [],
      banks: [],
    }));
    await expect(
      computeScope(strapi, 'api::deal.deal', 'update', 'doc1'),
    ).resolves.toEqual({ slugs: ['deal-of-the-day'], homepage: true });
  });

  it('never adds the landing slug to Coupon changes — coupons do not render there', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => relationDoc);
    await expect(
      computeScope(strapi, 'api::coupon.coupon', 'update', 'doc1'),
    ).resolves.toEqual({ slugs: ['amazon'], homepage: true });
  });

  it('carries the landing slug through the Deal pre-delete scope', async () => {
    const strapi = strapiWithFindOne(async () => relationDoc);
    await expect(
      preDeleteScope(strapi, 'api::deal.deal', 'doc1', 'update'),
    ).resolves.toEqual({ slugs: ['amazon', 'deal-of-the-day'], homepage: true });
  });
});

describe('entity edits baked into the deal landing page', () => {
  it('adds the landing slug for store and category updates', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({ slug: 'amazon' }));
    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'doc1'),
    ).resolves.toEqual({ slugs: ['amazon', 'deal-of-the-day'], homepage: true });

    const strapiCat = strapiWithFindOne(async () => ({ slug: 'electronics' }));
    await expect(
      computeScope(strapiCat, 'api::category.category', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['electronics', 'deal-of-the-day'],
      homepage: true,
    });
  });

  it('leaves bank and brand updates surgical — they do not render on the landing page', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({ slug: 'hdfc' }));
    await expect(
      computeScope(strapi, 'api::bank.bank', 'update', 'doc1'),
    ).resolves.toEqual({ slugs: ['hdfc'], homepage: true });
  });
});
