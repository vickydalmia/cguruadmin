import { describe, expect, it, vi } from 'vitest';
import { isRedirectNoteOnlyChange, preDeleteScope } from './scopes';

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
      slugs: ['amazon', 'deal-of-the-day'],
      homepage: true,
    });
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
  it('adds the landing slug for store and category updates', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({ slug: 'amazon' }));
    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['amazon', 'deal-of-the-day'],
      homepage: true,
      sitemap: true,
    });

    const strapiCat = strapiWithFindOne(async () => ({ slug: 'electronics' }));
    await expect(
      computeScope(strapiCat, 'api::category.category', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['electronics', 'deal-of-the-day'],
      homepage: true,
      sitemap: true,
    });
  });

  it('leaves bank and brand updates surgical — they do not render on the landing page', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({ slug: 'hdfc' }));
    await expect(
      computeScope(strapi, 'api::bank.bank', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: ['hdfc'],
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
