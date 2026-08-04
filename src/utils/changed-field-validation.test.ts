import { describe, expect, it, vi } from 'vitest';
import {
  isValidCanonicalUrl,
  validateChangedFields,
} from './changed-field-validation';

function harness(stored: unknown = null) {
  const findOne = vi.fn().mockResolvedValue(stored);
  return {
    strapi: { documents: vi.fn(() => ({ findOne })) } as any,
    findOne,
  };
}

describe('validateChangedFields', () => {
  it.each(['create', 'clone'])('validates strict fields on %s', async (action) => {
    const { strapi, findOne } = harness();
    await expect(
      validateChangedFields(strapi, 'api::store.store', action, {
        name: '<script>',
        slug: 'Stores/Amazon',
        websiteUrl: 'not-a-url',
      }),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      details: {
        errors: expect.arrayContaining([
          expect.objectContaining({ path: ['name'] }),
          expect.objectContaining({ path: ['slug'] }),
          expect.objectContaining({ path: ['websiteUrl'] }),
        ]),
      },
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('grandfathers unchanged invalid values in a full admin update', async () => {
    const legacy = {
      documentId: 'store-1',
      name: '<Legacy>',
      slug: 'Stores/Amazon',
      shortDescription: 'x'.repeat(159),
      websiteUrl: 'amazon',
      seo: {
        metaTitle: 'x'.repeat(71),
        canonicalUrl: '//legacy.example',
      },
    };
    const { strapi } = harness(legacy);

    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { ...legacy, shortDescription: legacy.shortDescription, documentId: undefined },
        'store-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects changing one invalid legacy value to another invalid value', async () => {
    const { strapi } = harness({
      documentId: 'store-1',
      websiteUrl: 'legacy-url',
    });
    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { websiteUrl: 'still-not-a-url' },
        'store-1',
      ),
    ).rejects.toThrow(/Website URL/);
  });

  it('allows repairing a legacy value', async () => {
    const { strapi } = harness({
      documentId: 'store-1',
      websiteUrl: 'legacy-url',
    });
    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { websiteUrl: 'https://www.amazon.in/' },
        'store-1',
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    'api::store.store',
    'api::brand.brand',
    'api::category.category',
    'api::bank.bank',
  ])('requires a 160-character short description for %s', async (uid) => {
    const { strapi } = harness();

    await expect(
      validateChangedFields(strapi, uid, 'create', {
        shortDescription: 'x'.repeat(159),
      }),
    ).rejects.toMatchObject({
      details: {
        errors: [
          expect.objectContaining({ path: ['shortDescription'] }),
        ],
      },
    });

    await expect(
      validateChangedFields(strapi, uid, 'create', {
        shortDescription: 'x'.repeat(160),
      }),
    ).resolves.toBeUndefined();

    await expect(
      validateChangedFields(strapi, uid, 'create', {
        shortDescription: 'x'.repeat(500),
      }),
    ).resolves.toBeUndefined();
  });

  it('allows an entity website URL to be omitted but validates one when supplied', async () => {
    const { strapi } = harness();

    for (const websiteUrl of [undefined, null, '']) {
      await expect(
        validateChangedFields(strapi, 'api::store.store', 'create', {
          websiteUrl,
        }),
      ).resolves.toBeUndefined();
    }

    await expect(
      validateChangedFields(strapi, 'api::store.store', 'create', {
        websiteUrl: 'amazon',
      }),
    ).rejects.toThrow(/Website URL/);
  });

  it.each(['api::coupon.coupon', 'api::deal.deal'])(
    'accepts browser-normalized affiliate URLs for %s',
    async (uid) => {
      const { strapi } = harness();

      await expect(
        validateChangedFields(strapi, uid, 'create', {
          affiliateLink:
            'https://www.myntra.com/adidas?sort=popularity&rf=Discount Range:30.0_100.0_30.0 TO 100.0&utm_source=admitad&utm_medium=affiliate&utm_campaign=306480_ADIDAS',
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.each(['api::coupon.coupon', 'api::deal.deal'])(
    'rejects unsafe affiliate URLs for %s',
    async (uid) => {
      const { strapi } = harness();

      await expect(
        validateChangedFields(strapi, uid, 'create', {
          affiliateLink: 'https://merchant.example/a\nb',
        }),
      ).rejects.toThrow(/Affiliate link/);

      await expect(
        validateChangedFields(strapi, uid, 'create', {
          affiliateLink: 'javascript:alert(1)',
        }),
      ).rejects.toThrow(/Affiliate link/);
    },
  );

  it('compares decimal representations semantically', async () => {
    const { strapi } = harness({
      documentId: 'deal-1',
      salePrice: '-1.00',
    });
    await expect(
      validateChangedFields(
        strapi,
        'api::deal.deal',
        'update',
        { salePrice: -1 },
        'deal-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('validates nested SEO fields only when their values change', async () => {
    const { strapi } = harness({
      documentId: 'home-1',
      seo: { ogImageAlt: 'x'.repeat(126) },
    });
    await expect(
      validateChangedFields(
        strapi,
        'api::homepage.homepage',
        'update',
        { seo: { ogImageAlt: 'y'.repeat(126) } },
        'home-1',
      ),
    ).rejects.toMatchObject({
      details: {
        errors: [
          expect.objectContaining({ path: ['seo', 'ogImageAlt'] }),
        ],
      },
    });
  });

  it('does no read for an unrelated partial update', async () => {
    const { strapi, findOne } = harness();
    await validateChangedFields(
      strapi,
      'api::coupon.coupon',
      'update',
      { contentStatus: 'expired' },
      'coupon-1',
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('merges omitted and nested fields from the clone source', async () => {
    const { strapi, findOne } = harness({
      documentId: 'store-1',
      name: 'Amazon',
      slug: 'amazon',
      websiteUrl: 'https://www.amazon.in/',
      seo: {
        metaTitle: 'Amazon coupons',
        metaDescription: 'Latest Amazon offers.',
        canonicalUrl: '/amazon/',
        ogTitle: 'Amazon offers',
        ogDescription: 'Save at Amazon.',
        ogImageAlt: 'Amazon offer card',
      },
    });

    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'clone',
        { seo: { ogTitle: 'Amazon India offers' } },
        'store-1',
      ),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'store-1',
        fields: expect.arrayContaining(['name', 'slug', 'websiteUrl']),
        populate: expect.objectContaining({
          seo: {
            fields: expect.arrayContaining([
              'metaTitle',
              'metaDescription',
              'canonicalUrl',
              'ogTitle',
              'ogDescription',
              'ogImageAlt',
            ]),
          },
        }),
      }),
    );
  });

  it('rejects a dotted job slug (job slugs are no-dot, matching the schema regex)', async () => {
    const { strapi, findOne } = harness();
    await expect(
      validateChangedFields(strapi, 'api::job.job', 'create', {
        slug: 'senior.engineer',
      }),
    ).rejects.toMatchObject({
      details: {
        errors: expect.arrayContaining([
          expect.objectContaining({ path: ['slug'] }),
        ]),
      },
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('accepts a plain hyphenated job slug', async () => {
    const { strapi } = harness();
    await expect(
      validateChangedFields(strapi, 'api::job.job', 'create', {
        slug: 'senior-engineer',
      }),
    ).resolves.toBeUndefined();
  });

  it('still accepts a dotted taxonomy slug (entity slugs keep dots)', async () => {
    const { strapi } = harness();
    await expect(
      validateChangedFields(strapi, 'api::brand.brand', 'create', {
        slug: 'flipkart.in',
      }),
    ).resolves.toBeUndefined();
  });

  it('validates inherited clone values as a new document', async () => {
    const { strapi } = harness({
      documentId: 'store-1',
      name: '<Legacy>',
      slug: 'amazon',
      websiteUrl: 'https://www.amazon.in/',
      seo: {},
    });

    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'clone',
        {},
        'store-1',
      ),
    ).rejects.toMatchObject({
      details: {
        errors: expect.arrayContaining([
          expect.objectContaining({ path: ['name'] }),
        ]),
      },
    });
  });
});

describe('validateChangedFields — STRICT (clean as you touch)', () => {
  it('STRICT blocks an unrelated human edit when shortDescription is under 160 characters', async () => {
    const { strapi } = harness({
      documentId: 'store-1',
      name: 'Amazon',
      shortDescription: 'x'.repeat(159),
    });

    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon India' },
        'store-1',
        true,
      ),
    ).rejects.toMatchObject({
      details: {
        errors: [
          expect.objectContaining({ path: ['shortDescription'] }),
        ],
      },
    });
  });

  it('NON-strict background writes grandfather an untouched short description', async () => {
    const { strapi } = harness({
      documentId: 'store-1',
      name: 'Amazon',
      shortDescription: 'x'.repeat(159),
    });

    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon India' },
        'store-1',
        false,
      ),
    ).resolves.toBeUndefined();
  });

  it('STRICT blocks a dirty untouched field on a human update', async () => {
    const { strapi } = harness({
      documentId: 'store-1',
      name: 'Amazon',
      slug: 'amazon',
      websiteUrl: 'legacy-not-a-url',
    });
    // Editor only touches `name`; the legacy dirty websiteUrl is untouched.
    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon India' },
        'store-1',
        true,
      ),
    ).rejects.toMatchObject({
      details: {
        errors: expect.arrayContaining([
          expect.objectContaining({ path: ['websiteUrl'] }),
        ]),
      },
    });
  });

  it('NON-strict leaves the same dirty untouched field alone (cron/grandfather path)', async () => {
    const { strapi } = harness({
      documentId: 'store-1',
      name: 'Amazon',
      slug: 'amazon',
      websiteUrl: 'legacy-not-a-url',
    });
    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon India' },
        'store-1',
        false,
      ),
    ).resolves.toBeUndefined();
  });

  it('STRICT blocks a re-sent unchanged dirty value the grandfather path would skip', async () => {
    const { strapi } = harness({ documentId: 'store-1', websiteUrl: 'legacy-url' });
    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { websiteUrl: 'legacy-url' },
        'store-1',
        true,
      ),
    ).rejects.toThrow(/Website URL/);
  });

  it('STRICT still passes when the whole effective record is clean', async () => {
    const { strapi } = harness({
      documentId: 'store-1',
      name: 'Amazon',
      slug: 'amazon',
      websiteUrl: 'https://www.amazon.in/',
      seo: { metaTitle: 'Amazon', canonicalUrl: '/amazon/' },
    });
    await expect(
      validateChangedFields(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon India' },
        'store-1',
        true,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('isValidCanonicalUrl', () => {
  it.each([
    '',
    '/',
    '/airport-tour-coupons/',
    '/company/about',
    'https://beta.couponzguru.com/airport-tour-coupons/',
    'https://www.couponzguru.com/',
    'https://www.example.com/x',
  ])('accepts a URL-only canonical: %s', (value) => {
    expect(isValidCanonicalUrl(value)).toBe(true);
  });

  it.each([
    '<link rel="canonical" href="https://beta.couponzguru.com/airport-tour-coupons/" />',
    '//evil.example/path',
    // WHATWG URL resolution folds "\" to "/" in http(s) contexts, so this is
    // "//evil.example/" — the same off-site escape — spelled with a backslash.
    '/\\evil.example/',
    'https://www.example.com/\\evil.example',
    '/ x',
    '/x\0y',
    'airport-tour-coupons',
    '/airport tour-coupons/',
    '/airport-tour-coupons/?campaign=test',
    '/airport-tour-coupons/#offers',
    'javascript:alert(1)',
  ])('rejects a non-URL canonical: %s', (value) => {
    expect(isValidCanonicalUrl(value)).toBe(false);
  });
});
