import { describe, expect, it, vi } from 'vitest';
import { isRedirectNoteOnlyChange, preDeleteScope } from './scopes';

function strapiWithFindOne(
  findOne: (args: any) => Promise<any>,
  findMany: (uid: string, args: any) => Promise<any[]> = async () => [],
) {
  return {
    documents: (uid: string) => ({
      findOne,
      findMany: (args: any) => findMany(uid, args),
    }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;
}

describe('preDeleteScope failure escalation', () => {
  it('returns the related-page scope when the pre-read succeeds', async () => {
    const strapi = strapiWithFindOne(async () => ({
      id: 41,
      stores: [{ slug: 'amazon' }],
      brands: [],
      categories: [],
      banks: [],
    }));
    await expect(
      preDeleteScope(strapi, 'api::coupon.coupon', 'doc1', 'update'),
    ).resolves.toEqual({
      slugs: ['coupon/41', 'amazon'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });

  it('escalates to full when a DELETE pre-read fails (relations unknowable afterwards)', async () => {
    const strapi = strapiWithFindOne(async () => {
      throw new Error('db hiccup');
    });
    await expect(
      preDeleteScope(strapi, 'api::deal.deal', 'doc1', 'delete'),
    ).resolves.toEqual({ full: true, refreshScopes: ['routes'] });
  });

  it('escalates an UPDATE pre-read failure because removed relations are unknowable', async () => {
    const strapi = strapiWithFindOne(async () => {
      throw new Error('db hiccup');
    });
    await expect(
      preDeleteScope(strapi, 'api::coupon.coupon', 'doc1', 'update'),
    ).resolves.toEqual({ full: true, refreshScopes: ['routes'] });
    expect(strapi.log.warn).toHaveBeenCalled();
  });

  it('treats a vanished offer as uncertain for both delete and update', async () => {
    const strapi = strapiWithFindOne(async () => null);
    await expect(
      preDeleteScope(strapi, 'api::coupon.coupon', 'doc1', 'delete'),
    ).resolves.toEqual({ full: true, refreshScopes: ['routes'] });
    await expect(
      preDeleteScope(strapi, 'api::coupon.coupon', 'doc1', 'publish'),
    ).resolves.toEqual({ full: true, refreshScopes: ['routes'] });
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
    id: 42,
    stores: [{ name: 'Amazon India', slug: 'amazon' }],
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
    ).resolves.toEqual({
      slugs: ['deal-of-the-day'],
      sitemap: true,
    });
  });

  it('appends the landing slug to every Deal change scope', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => relationDoc);
    await expect(
      computeScope(strapi, 'api::deal.deal', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['deal/42', 'amazon', 'amazon-india-deals', 'deal-of-the-day'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });

  it('covers curated-only Deals that have no entity relations', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({
      id: 42,
      stores: [],
      brands: [],
      categories: [],
      banks: [],
    }));
    await expect(
      computeScope(strapi, 'api::deal.deal', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['deal/42', 'deal-of-the-day'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });

  it('never adds the landing slug to Coupon changes — coupons do not render there', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => relationDoc);
    await expect(
      computeScope(strapi, 'api::coupon.coupon', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['coupon/42', 'amazon'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });

  it('includes the new singular page when a Coupon is created', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({
      id: 73,
      stores: [],
      brands: [],
      categories: [],
      banks: [],
    }));
    await expect(
      computeScope(strapi, 'api::coupon.coupon', 'create', 'coupon-new'),
    ).resolves.toEqual({
      slugs: ['coupon/73'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });

  it('refreshes every entity page that owns a Coupon through membership or curation', async () => {
    const { computeScope } = await import('./scopes');
    const findMany = vi.fn(async (uid: string, args: any) => {
      expect(args.filters).toEqual({
        $or: [
          { coupons: { documentId: { $eq: 'coupon-1' } } },
          { topPickCoupons: { documentId: { $eq: 'coupon-1' } } },
          { orderedCoupons: { documentId: { $eq: 'coupon-1' } } },
        ],
      });
      if (uid === 'api::store.store') return [{ slug: 'amazon' }];
      if (uid === 'api::category.category') {
        return [{ slug: 'categories/electronics' }];
      }
      return [];
    });
    const strapi = strapiWithFindOne(
      async () => ({
        id: 77,
        stores: [{ slug: 'amazon' }],
        brands: [],
        categories: [],
        banks: [],
      }),
      findMany,
    );

    await expect(
      computeScope(
        strapi,
        'api::coupon.coupon',
        'update',
        'coupon-1',
      ),
    ).resolves.toEqual({
      slugs: ['coupon/77', 'amazon', 'electronics'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
    expect(findMany).toHaveBeenCalledTimes(4);
  });

  it('refreshes every entity page that owns a Deal through its deals relation', async () => {
    const { computeScope } = await import('./scopes');
    const findMany = vi.fn(async (uid: string, args: any) => {
      expect(args.filters).toEqual({
        deals: { documentId: { $eq: 'deal-1' } },
      });
      if (uid === 'api::brand.brand') {
        return [{ name: 'Samsung Mobile', slug: 'brands/samsung' }];
      }
      if (uid === 'api::bank.bank') {
        return [{ name: 'HDFC Bank', slug: 'banks/hdfc' }];
      }
      return [];
    });
    const strapi = strapiWithFindOne(
      async () => ({
        id: 88,
        stores: [],
        brands: [],
        categories: [],
        banks: [],
      }),
      findMany,
    );

    await expect(
      computeScope(strapi, 'api::deal.deal', 'update', 'deal-1'),
    ).resolves.toEqual({
      slugs: [
        'deal/88',
        'samsung',
        'hdfc',
        'samsung-mobile-deals',
        'hdfc-bank-deals',
        'deal-of-the-day',
      ],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
    expect(findMany).toHaveBeenCalledTimes(4);
  });

  it('captures every entity-owned Coupon association before delete', async () => {
    const strapi = strapiWithFindOne(
      async () => ({
        id: 91,
        stores: [],
        brands: [],
        categories: [],
        banks: [],
      }),
      async (uid) =>
        uid === 'api::bank.bank' ? [{ slug: 'banks/hdfc' }] : [],
    );
    await expect(
      preDeleteScope(
        strapi,
        'api::coupon.coupon',
        'coupon-1',
        'delete',
      ),
    ).resolves.toEqual({
      slugs: ['coupon/91', 'hdfc'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });

  it('carries the landing slug through the Deal pre-delete scope', async () => {
    const strapi = strapiWithFindOne(async () => relationDoc);
    await expect(
      preDeleteScope(strapi, 'api::deal.deal', 'doc1', 'update'),
    ).resolves.toEqual({
      slugs: ['deal/42', 'amazon', 'amazon-india-deals', 'deal-of-the-day'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });
});

describe('managed page SEO scopes', () => {
  it('refreshes sitemap metadata for homepage and About edits', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => {
      throw new Error('must not be called');
    });

    await expect(
      computeScope(strapi, 'api::homepage.homepage', 'update', 'home-1'),
    ).resolves.toEqual({ homepage: true, sitemap: true });
    await expect(
      computeScope(strapi, 'api::about-page.about-page', 'update', 'about-1'),
    ).resolves.toEqual({ slugs: ['about-us'], sitemap: true });
  });

  it('refreshes the careers listing, active jobs, and sitemap metadata', async () => {
    const { computeScope } = await import('./scopes');
    const findMany = vi.fn().mockResolvedValue([
      { slug: 'seo-editor' },
      { slug: 'designer' },
    ]);
    const strapi = {
      documents: () => ({ findMany }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    await expect(
      computeScope(
        strapi,
        'api::career-page.career-page',
        'update',
        'career-1',
      ),
    ).resolves.toEqual({
      slugs: ['careers', 'careers/seo-editor', 'careers/designer'],
      sitemap: true,
    });
  });
});

describe('entity Deal-page SEO scope', () => {
  const entityDoc = async () => ({ name: 'Amazon India', slug: 'amazon' });

  it('narrows an entityDealPageSeo-only write to the generated page', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(entityDoc);

    // The hidden component renders on /amazon-india-deals/ and nowhere else, so the
    // entity page, the homepage and the deal-of-the-day page stay untouched.
    // `sitemap` survives: indexingEnabled decides shard membership.
    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'store-1', {
        entityDealPageSeo: { indexingEnabled: true },
      }),
    ).resolves.toEqual({ slugs: ['amazon-india-deals'], sitemap: true });
  });

  it('keeps the broad scope for any other entity write', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(entityDoc);

    const broad = {
      slugs: ['amazon', 'amazon-india-deals', 'deal-of-the-day'],
      homepage: true,
      sitemap: true,
    };

    // No payload at all.
    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'store-1'),
    ).resolves.toEqual(broad);

    // SEO alongside a visible field is NOT SEO-only.
    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'store-1', {
        name: 'Amazon India',
        entityDealPageSeo: { indexingEnabled: true },
      }),
    ).resolves.toEqual({ ...broad, refreshScopes: ['routes'] });

    // A publish carrying the same payload still rebuilds broadly.
    await expect(
      computeScope(strapi, 'api::store.store', 'publish', 'store-1', {
        entityDealPageSeo: { indexingEnabled: true },
      }),
    ).resolves.toEqual(broad);
  });
});

describe('error page scope', () => {
  it('revalidates only the internal error documents', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => {
      throw new Error('must not be called');
    });
    const scope = await computeScope(
      strapi,
      'api::error-page.error-page',
      'update',
      'doc1',
    );
    expect(scope).toEqual({
      refreshScopes: ['error-page'],
      slugs: [
        'error-pages/400',
        'error-pages/403',
        'error-pages/404',
        'error-pages/405',
        'error-pages/414',
        'error-pages/416',
        'error-pages/500',
        'error-pages/501',
        'error-pages/502',
        'error-pages/503',
        'error-pages/504',
        'error-pages/template',
      ],
    });
  });
});

describe('entity edits baked into the deal landing page', () => {
  it('falls back to a route-aware full invalidation when identity is missing', async () => {
    const { computeScope } = await import('./scopes');
    await expect(
      computeScope(
        strapiWithFindOne(async () => null),
        'api::store.store',
        'update',
        undefined,
      ),
    ).resolves.toEqual({ full: true, refreshScopes: ['routes'] });
    await expect(
      computeScope(
        strapiWithFindOne(async () => null),
        'api::store.store',
        'update',
        'missing',
      ),
    ).resolves.toEqual({ full: true, refreshScopes: ['routes'] });
  });

  it('adds the landing slug for store and category updates', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({
      name: 'Amazon India',
      slug: 'amazon',
    }));
    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['amazon', 'amazon-india-deals', 'deal-of-the-day'],
      homepage: true,
      sitemap: true,
    });

    const strapiCat = strapiWithFindOne(async () => ({
      name: 'Consumer Electronics',
      slug: 'electronics',
    }));
    await expect(
      computeScope(strapiCat, 'api::category.category', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['electronics', 'consumer-electronics-deals', 'deal-of-the-day'],
      homepage: true,
      sitemap: true,
    });
  });

  it('leaves bank and brand updates surgical — they do not render on the landing page', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({
      name: 'HDFC Bank',
      slug: 'hdfc',
    }));
    await expect(
      computeScope(strapi, 'api::bank.bank', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['hdfc', 'hdfc-bank-deals'],
      homepage: true,
      sitemap: true,
    });
  });
});

describe('isRedirectNoteOnlyChange', () => {
  const before = {
    from: '/old-page/',
    to: '/new-page/',
    statusCode: '301',
    active: true,
  };

  it('is true when the payload only changes note (full admin form resend)', () => {
    expect(
      isRedirectNoteOnlyChange(before, { ...before, note: 'migrated from WP' }),
    ).toBe(true);
  });

  it('is true when material fields are omitted from the payload entirely', () => {
    expect(isRedirectNoteOnlyChange(before, { note: 'partial update' })).toBe(
      true,
    );
  });

  it('is false for every material field change', () => {
    expect(
      isRedirectNoteOnlyChange(before, { ...before, from: '/other/' }),
    ).toBe(false);
    expect(isRedirectNoteOnlyChange(before, { ...before, to: '/elsewhere/' })).toBe(
      false,
    );
    expect(
      isRedirectNoteOnlyChange(before, { ...before, statusCode: '302' }),
    ).toBe(false);
    expect(isRedirectNoteOnlyChange(before, { ...before, active: false })).toBe(
      false,
    );
  });

  it('fails toward the sweep when the before-state or payload is unknown', () => {
    expect(isRedirectNoteOnlyChange(null, { note: 'x' })).toBe(false);
    expect(isRedirectNoteOnlyChange(before, null)).toBe(false);
    expect(isRedirectNoteOnlyChange(before, undefined)).toBe(false);
  });

  it('treats null and undefined material values as equal (unset either way)', () => {
    expect(
      isRedirectNoteOnlyChange(
        { ...before, statusCode: null },
        { ...before, statusCode: undefined },
      ),
    ).toBe(true);
  });
});
