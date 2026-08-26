import { describe, expect, it, vi } from 'vitest';
import { preDeleteScope } from './offer-relation-scopes';
import { isRedirectNoteOnlyChange } from './scopes';

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
      slugs: ['coupon/41', 'amazon', 'independence-day-sale-coupons'],
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

  it('rebuilds only the Independence Day landing when its single type changes', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => {
      throw new Error('must not be called');
    });
    await expect(
      computeScope(
        strapi,
        'api::independence-day-sale-page.independence-day-sale-page',
        'update',
        'doc1',
      ),
    ).resolves.toEqual({
      slugs: ['independence-day-sale-coupons'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });

  it('appends the landing slug to every Deal change scope', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => relationDoc);
    await expect(
      computeScope(strapi, 'api::deal.deal', 'update', 'doc1'),
    ).resolves.toEqual({
      slugs: [
        'deal/42',
        'amazon',
        'independence-day-sale-coupons',
        'deal-of-the-day',
      ],
      optionalSlugs: ['amazon-india-deals'],
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
      slugs: ['deal/42', 'independence-day-sale-coupons', 'deal-of-the-day'],
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
      slugs: ['coupon/42', 'amazon', 'independence-day-sale-coupons'],
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
      slugs: ['coupon/73', 'independence-day-sale-coupons'],
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
      slugs: [
        'coupon/77',
        'amazon',
        'electronics',
        'independence-day-sale-coupons',
      ],
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
        'independence-day-sale-coupons',
        'deal-of-the-day',
      ],
      optionalSlugs: ['samsung-mobile-deals', 'hdfc-bank-deals'],
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
      slugs: ['coupon/91', 'hdfc', 'independence-day-sale-coupons'],
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
      slugs: [
        'deal/42',
        'amazon',
        'independence-day-sale-coupons',
        'deal-of-the-day',
      ],
      optionalSlugs: ['amazon-india-deals'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });
  });
});

describe('festive offer scope', () => {
  const entityDoc = { name: 'Flipkart', slug: 'flipkart' };
  const FESTIVE_ON = {
    isFestiveOffer: true,
    festiveOfferTitle: 'Big Billion Days',
    festiveOfferDescription: '<p>Up to 80% off</p>',
  };

  it('repaints exactly the pages showing offers that check out with the merchant', async () => {
    // A festive change stales every card whose checkoutMerchant is this Store:
    // each offer's detail page, the entity pages listing those offers, the
    // deal landing page (Deals involved) and the homepage — merged into the
    // Store's own narrow scope, NOT a full-site rebuild.
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(
      async () => entityDoc,
      async (uid) => {
        if (uid === 'api::coupon.coupon') {
          return [
            {
              id: 11,
              documentId: 'c1',
              stores: [{ name: 'Amazon India', slug: 'amazon-coupons' }],
            },
          ];
        }
        if (uid === 'api::deal.deal') {
          return [
            { id: 7, documentId: 'd1', brands: [{ name: 'Nike', slug: 'nike' }] },
          ];
        }
        return []; // reverse curated-relation lookups find nothing extra
      },
    );

    await expect(
      computeScope(
        strapi,
        'api::store.store',
        'update',
        'store-1',
        FESTIVE_ON,
        { isFestiveOffer: false },
      ),
    ).resolves.toEqual({
      full: false,
      homepage: true,
      sitemap: true,
      slugs: [
        'flipkart',
        'deal-of-the-day',
        'independence-day-sale-coupons',
        'coupon/11',
        'amazon-coupons',
        'deal/7',
        'nike',
      ],
      optionalSlugs: ['flipkart-deals', 'nike-deals'],
    });
  });

  it('adds no repaint pages when no offer names the merchant', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => entityDoc);

    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'store-1', FESTIVE_ON, {
        isFestiveOffer: false,
      }),
    ).resolves.toEqual({
      slugs: ['flipkart', 'deal-of-the-day', 'independence-day-sale-coupons'],
      optionalSlugs: ['flipkart-deals'],
      homepage: true,
      sitemap: true,
    });
  });

  it('degrades to a full rebuild past the scan bound', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(
      async () => entityDoc,
      async (uid) =>
        uid === 'api::coupon.coupon'
          ? Array.from({ length: 1_001 }, (_, i) => ({
              id: i + 1,
              documentId: `c${i}`,
            }))
          : [],
    );

    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'store-1', FESTIVE_ON, {
        isFestiveOffer: false,
      }),
    ).resolves.toEqual({ full: true, refreshScopes: ['routes'] });
  });

  it('falls back to a full rebuild when the merchant scan fails', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(
      async () => entityDoc,
      async () => {
        throw new Error('db down');
      },
    );

    await expect(
      computeScope(strapi, 'api::brand.brand', 'update', 'brand-1', {
        isFestiveOffer: false,
      }),
    ).resolves.toEqual({ full: true, refreshScopes: ['routes'] });
  });

  it('leaves an ordinary Store edit on the narrow scope', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => entityDoc);

    await expect(
      computeScope(strapi, 'api::store.store', 'update', 'store-1', {
        shortDescription: 'A marketplace',
      }),
    ).resolves.toEqual({
      slugs: ['flipkart', 'deal-of-the-day', 'independence-day-sale-coupons'],
      optionalSlugs: ['flipkart-deals'],
      homepage: true,
      sitemap: true,
    });
  });

  it('does not escalate for entity types with no festive fields', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => ({
      name: 'Fashion',
      slug: 'categories/fashion',
    }));

    await expect(
      computeScope(strapi, 'api::category.category', 'update', 'cat-1', {
        shortDescription: 'Clothes',
      }),
    ).resolves.toMatchObject({ homepage: true });
  });

  it('keeps the narrow scope when the festive fields are present but UNCHANGED', async () => {
    // The content-manager edit form submits the full document, so every
    // Store save carries all three festive keys. A logo fix must not become
    // a full-site rebuild just because the untouched values rode along.
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => entityDoc);
    const festive = {
      isFestiveOffer: true,
      festiveOfferTitle: 'Big Billion Days',
      festiveOfferDescription: '<p>Up to 80% off</p>',
    };

    await expect(
      computeScope(
        strapi,
        'api::store.store',
        'update',
        'store-1',
        { name: 'Flipkart', ...festive },
        festive,
      ),
    ).resolves.toEqual({
      slugs: ['flipkart', 'deal-of-the-day', 'independence-day-sale-coupons'],
      optionalSlugs: ['flipkart-deals'],
      homepage: true,
      sitemap: true,
      // From the payload carrying `name` (identity refresh), NOT from festive.
      refreshScopes: ['routes'],
    });
  });

  it('runs the repaint scan for a full-document save whose festive values changed', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(
      async () => entityDoc,
      async (uid) =>
        uid === 'api::coupon.coupon' ? [{ id: 3, documentId: 'c3' }] : [],
    );

    await expect(
      computeScope(
        strapi,
        'api::store.store',
        'update',
        'store-1',
        {
          name: 'Flipkart',
          isFestiveOffer: true,
          festiveOfferTitle: 'Diwali Dhamaka',
          festiveOfferDescription: '<p>Up to 80% off</p>',
        },
        {
          isFestiveOffer: true,
          festiveOfferTitle: 'Big Billion Days',
          festiveOfferDescription: '<p>Up to 80% off</p>',
        },
      ),
    ).resolves.toEqual({
      full: false,
      homepage: true,
      sitemap: true,
      slugs: [
        'flipkart',
        'deal-of-the-day',
        'independence-day-sale-coupons',
        'coupon/3',
      ],
      optionalSlugs: ['flipkart-deals'],
      refreshScopes: ['routes'],
    });
  });
});

describe('festiveOfferChanged', () => {
  const live = {
    isFestiveOffer: true,
    festiveOfferTitle: 'Big Billion Days',
    festiveOfferDescription: '<p>Up to 80% off</p>',
  };

  it('is false when the payload never touches the festive keys', async () => {
    const { festiveOfferChanged } = await import('./festive-offer-scopes');
    expect(festiveOfferChanged({ name: 'Flipkart' }, live)).toBe(false);
    expect(festiveOfferChanged(null, live)).toBe(false);
  });

  it('is false when the submitted values match the row', async () => {
    const { festiveOfferChanged } = await import('./festive-offer-scopes');
    expect(festiveOfferChanged({ ...live }, live)).toBe(false);
  });

  it('detects toggling the campaign on and off', async () => {
    const { festiveOfferChanged } = await import('./festive-offer-scopes');
    expect(
      festiveOfferChanged({ isFestiveOffer: false }, live),
    ).toBe(true);
    expect(
      festiveOfferChanged(
        { isFestiveOffer: true },
        { ...live, isFestiveOffer: false },
      ),
    ).toBe(true);
  });

  it('detects a copy edit on a live campaign', async () => {
    const { festiveOfferChanged } = await import('./festive-offer-scopes');
    expect(
      festiveOfferChanged({ festiveOfferTitle: 'Diwali Dhamaka' }, live),
    ).toBe(true);
  });

  it('ignores edits that never render: copy changes while the toggle is off', async () => {
    // The response walker only ships complete, switched-on campaigns, so a
    // draft title typed before enabling the toggle changes nothing on any page.
    const { festiveOfferChanged } = await import('./festive-offer-scopes');
    expect(
      festiveOfferChanged(
        { festiveOfferTitle: 'Draft title' },
        { ...live, isFestiveOffer: false },
      ),
    ).toBe(false);
  });

  it('ignores an incomplete campaign in both states', async () => {
    const { festiveOfferChanged } = await import('./festive-offer-scopes');
    expect(
      festiveOfferChanged(
        { festiveOfferDescription: '' },
        { ...live, festiveOfferDescription: '   ' },
      ),
    ).toBe(false);
  });

  it('fails toward invalidation when the before-row could not be read', async () => {
    const { festiveOfferChanged } = await import('./festive-offer-scopes');
    expect(festiveOfferChanged({ isFestiveOffer: true }, null)).toBe(true);
    expect(festiveOfferChanged({ isFestiveOffer: false }, undefined)).toBe(true);
  });
});

describe('touchesFestiveOffer', () => {
  it('matches any of the three festive keys', async () => {
    const { touchesFestiveOffer } = await import('./festive-offer-scopes');
    expect(touchesFestiveOffer({ isFestiveOffer: true })).toBe(true);
    expect(touchesFestiveOffer({ festiveOfferTitle: 'x' })).toBe(true);
    expect(touchesFestiveOffer({ festiveOfferDescription: null })).toBe(true);
  });

  it('matches a key present but explicitly cleared', async () => {
    // Switching a campaign OFF stales exactly the same pages as switching it on.
    const { touchesFestiveOffer } = await import('./festive-offer-scopes');
    expect(touchesFestiveOffer({ isFestiveOffer: false })).toBe(true);
  });

  it('ignores unrelated payloads', async () => {
    const { touchesFestiveOffer } = await import('./festive-offer-scopes');
    expect(touchesFestiveOffer({ name: 'Flipkart' })).toBe(false);
    expect(touchesFestiveOffer(null)).toBe(false);
    expect(touchesFestiveOffer([{ isFestiveOffer: true }])).toBe(false);
  });
});

describe('managed page SEO scopes', () => {
  it('refreshes sitemap metadata for homepage and every static editorial page edit', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(async () => {
      throw new Error('must not be called');
    });

    await expect(
      computeScope(strapi, 'api::homepage.homepage', 'update', 'home-1'),
    ).resolves.toEqual({ homepage: true, sitemap: true });
    await expect(
      computeScope(strapi, 'api::about-page.about-page', 'update', 'about-1'),
    ).resolves.toEqual({
      slugs: ['about-us'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
    await expect(
      computeScope(
        strapi,
        'api::contact-page.contact-page',
        'update',
        'contact-1',
      ),
    ).resolves.toEqual({
      slugs: ['contact-us'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
    await expect(
      computeScope(strapi, 'api::faq-page.faq-page', 'update', 'faq-1'),
    ).resolves.toEqual({
      slugs: ['faqs'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
    await expect(
      computeScope(
        strapi,
        'api::testimonials-page.testimonials-page',
        'update',
        'testimonials-1',
      ),
    ).resolves.toEqual({
      slugs: ['testimonials'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
    await expect(
      computeScope(
        strapi,
        'api::partner-with-us-page.partner-with-us-page',
        'update',
        'partner-page-1',
      ),
    ).resolves.toEqual({
      slugs: ['partner-with-us'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
    await expect(
      computeScope(
        strapi,
        'api::privacy-policy-page.privacy-policy-page',
        'update',
        'privacy-1',
      ),
    ).resolves.toEqual({
      slugs: ['privacy-policy'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
    await expect(
      computeScope(
        strapi,
        'api::terms-and-conditions-page.terms-and-conditions-page',
        'update',
        'terms-1',
      ),
    ).resolves.toEqual({
      slugs: ['terms-and-conditions'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
    await expect(
      computeScope(
        strapi,
        'api::affiliate-disclosure-page.affiliate-disclosure-page',
        'update',
        'affiliate-1',
      ),
    ).resolves.toEqual({
      slugs: ['affiliate-disclosure'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
    await expect(
      computeScope(strapi, 'api::culture-page.culture-page', 'update', 'culture-1'),
    ).resolves.toEqual({
      slugs: ['culture'],
      sitemap: true,
      refreshScopes: ['routes'],
    });
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
      refreshScopes: ['routes'],
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
    ).resolves.toEqual({
      optionalSlugs: ['amazon-india-deals'],
      sitemap: true,
    });
  });

  it('keeps the broad scope for any other entity write', async () => {
    const { computeScope } = await import('./scopes');
    const strapi = strapiWithFindOne(entityDoc);

    const broad = {
      slugs: ['amazon', 'deal-of-the-day', 'independence-day-sale-coupons'],
      optionalSlugs: ['amazon-india-deals'],
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
      slugs: ['amazon', 'deal-of-the-day', 'independence-day-sale-coupons'],
      optionalSlugs: ['amazon-india-deals'],
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
      slugs: [
        'electronics',
        'deal-of-the-day',
        'independence-day-sale-coupons',
      ],
      optionalSlugs: ['consumer-electronics-deals'],
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
      slugs: ['hdfc'],
      optionalSlugs: ['hdfc-bank-deals'],
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
