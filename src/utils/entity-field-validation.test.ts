import { describe, expect, it, vi } from 'vitest';
import {
  validateEntityFields,
  validateEntityFieldsForWrite,
} from './entity-field-validation';

const STORE = 'api::store.store';
const BRAND = 'api::brand.brand';

describe('validateEntityFields', () => {
  it('is a no-op for non-taxonomy content types', () => {
    expect(() =>
      validateEntityFields('api::coupon.coupon', 'update', { ratingCount: 9e18 })
    ).not.toThrow();
  });

  it('ignores null / non-object data', () => {
    expect(() => validateEntityFields(STORE, 'update', null)).not.toThrow();
  });

  describe('rating range', () => {
    it('accepts an in-range ratingCount and ratingAverage', () => {
      expect(() =>
        validateEntityFields(STORE, 'update', { ratingCount: 1250, ratingAverage: 4.3 })
      ).not.toThrow();
    });

    it('rejects a ratingCount above the integer ceiling with a field path', () => {
      try {
        validateEntityFields(STORE, 'update', { ratingCount: 9999999999 });
        throw new Error('expected to throw');
      } catch (err: any) {
        expect(err.details?.errors?.[0]?.path).toEqual(['ratingCount']);
      }
    });

    it('rejects a negative or non-integer ratingCount', () => {
      expect(() => validateEntityFields(STORE, 'update', { ratingCount: -5 })).toThrow(
        /Rating count/
      );
      expect(() => validateEntityFields(STORE, 'update', { ratingCount: 3.5 })).toThrow(
        /Rating count/
      );
    });

    it('accepts numeric strings from form payloads', () => {
      expect(() =>
        validateEntityFields(STORE, 'update', { ratingCount: '1250' })
      ).not.toThrow();
    });

    it('rejects a ratingAverage outside 0–5', () => {
      try {
        validateEntityFields(STORE, 'update', { ratingAverage: 7 });
        throw new Error('expected to throw');
      } catch (err: any) {
        expect(err.details?.errors?.[0]?.path).toEqual(['ratingAverage']);
      }
    });

    it('ignores absent rating fields', () => {
      expect(() => validateEntityFields(STORE, 'update', { name: 'x' })).not.toThrow();
    });

    it('grandfathers an unchanged out-of-range value in a full form', () => {
      expect(() =>
        validateEntityFields(
          STORE,
          'update',
          { ratingAverage: '7' },
          { ratingAverage: 7 },
        )
      ).not.toThrow();
    });
  });

  describe('FAQ enabled', () => {
    it('rejects faqEnabled with no faqs', () => {
      try {
        validateEntityFields(STORE, 'update', { faqEnabled: true, faqs: [] });
        throw new Error('expected to throw');
      } catch (err: any) {
        expect(err.details?.errors?.[0]?.path).toEqual(['faqs']);
      }
    });

    it('rejects faqEnabled when faqs is absent', () => {
      expect(() =>
        validateEntityFields(STORE, 'update', { faqEnabled: true })
      ).toThrow(/FAQ/);
    });

    it('accepts faqEnabled with at least one faq', () => {
      expect(() =>
        validateEntityFields(STORE, 'update', {
          faqEnabled: true,
          faqs: [{ question: 'Q?', answer: 'A' }],
        })
      ).not.toThrow();
    });

    it('accepts faqEnabled off regardless of faqs', () => {
      expect(() =>
        validateEntityFields(STORE, 'update', { faqEnabled: false, faqs: [] })
      ).not.toThrow();
    });

    it('grandfathers an unchanged enabled-but-empty legacy FAQ state', () => {
      expect(() =>
        validateEntityFields(
          STORE,
          'update',
          { faqEnabled: true, faqs: [] },
          { faqEnabled: true, faqs: [] },
        )
      ).not.toThrow();
    });
  });

  describe('brand required SEO', () => {
    it('rejects a brand create without SEO title/description', () => {
      try {
        validateEntityFields(BRAND, 'create', { name: 'Nike' });
        throw new Error('expected to throw');
      } catch (err: any) {
        const paths = err.details?.errors?.map((e: any) => e.path.join('.'));
        expect(paths).toContain('seo.metaTitle');
        expect(paths).toContain('seo.metaDescription');
      }
    });

    it('rejects a brand update whose seo has blank subfields', () => {
      expect(() =>
        validateEntityFields(BRAND, 'update', {
          seo: { metaTitle: '  ', metaDescription: '' },
        })
      ).toThrow(/SEO/);
    });

    it('accepts a brand with complete SEO', () => {
      expect(() =>
        validateEntityFields(BRAND, 'create', {
          seo: { metaTitle: 'Nike deals', metaDescription: 'Save on Nike' },
        })
      ).not.toThrow();
    });

    it('skips SEO enforcement on an update that omits the seo component', () => {
      expect(() =>
        validateEntityFields(BRAND, 'update', { ratingCount: 5 })
      ).not.toThrow();
    });

    it('grandfathers unchanged blank legacy SEO in a full form', () => {
      expect(() =>
        validateEntityFields(
          BRAND,
          'update',
          { seo: { metaTitle: '', metaDescription: null } },
          { seo: { metaTitle: '', metaDescription: null } },
        )
      ).not.toThrow();
    });

    it('does not enforce SEO on non-brand taxonomies', () => {
      expect(() =>
        validateEntityFields(STORE, 'create', { name: 'Amazon' })
      ).not.toThrow();
    });

    it('inherits required brand SEO for a partial clone', () => {
      expect(() =>
        validateEntityFields(
          BRAND,
          'clone',
          {},
          {
            seo: {
              metaTitle: 'Nike deals',
              metaDescription: 'Save on Nike',
            },
          },
        )
      ).not.toThrow();
    });

    it('merges a partial clone SEO component over the source', () => {
      expect(() =>
        validateEntityFields(
          BRAND,
          'clone',
          { seo: { metaTitle: 'Nike offers' } },
          {
            seo: {
              metaTitle: 'Nike deals',
              metaDescription: 'Save on Nike',
            },
          },
        )
      ).not.toThrow();
    });

    it('rejects an explicit clone clear of inherited brand SEO', () => {
      expect(() =>
        validateEntityFields(
          BRAND,
          'clone',
          { seo: null },
          {
            seo: {
              metaTitle: 'Nike deals',
              metaDescription: 'Save on Nike',
            },
          },
        )
      ).toThrow(/SEO/);
    });
  });

  describe('festive offer', () => {
    const CATEGORY = 'api::category.category';

    it('accepts the toggle off regardless of the other fields', () => {
      expect(() =>
        validateEntityFields(STORE, 'update', {
          isFestiveOffer: false,
          festiveOfferTitle: null,
          festiveOfferDescription: null,
        }),
      ).not.toThrow();
    });

    it('accepts the toggle on with both fields filled in', () => {
      expect(() =>
        validateEntityFields(BRAND, 'update', {
          isFestiveOffer: true,
          festiveOfferTitle: 'Diwali Dhamaka',
          festiveOfferDescription: '<p>Up to 70% off</p>',
        }),
      ).not.toThrow();
    });

    it('rejects the toggle on with both fields missing, naming both', () => {
      // Visibility is not requiredness: Strapi skips validation entirely for a
      // field hidden by conditions.visible, so nothing else catches this.
      try {
        validateEntityFields(STORE, 'create', { isFestiveOffer: true });
        throw new Error('expected to throw');
      } catch (err: any) {
        const paths = err.details?.errors?.map((e: any) => e.path.join('.'));
        expect(paths).toEqual(['festiveOfferTitle', 'festiveOfferDescription']);
      }
    });

    it('rejects a blank-after-trim title', () => {
      expect(() =>
        validateEntityFields(BRAND, 'create', {
          isFestiveOffer: true,
          festiveOfferTitle: '   ',
          festiveOfferDescription: '<p>x</p>',
        }),
      ).toThrow(/festive offer title/);
    });

    it('reads the toggle from the stored row on a partial update', () => {
      // The payload sets only the title; whether the rule applies at all comes
      // from what is already stored.
      expect(() =>
        validateEntityFields(
          STORE,
          'update',
          { festiveOfferTitle: '' },
          { isFestiveOffer: true, festiveOfferDescription: '<p>x</p>' },
        ),
      ).toThrow(/festive offer title/);
    });

    it('does not apply to category or bank', () => {
      expect(() =>
        validateEntityFields(CATEGORY, 'create', { isFestiveOffer: true }),
      ).not.toThrow();
    });

    it('grandfathers an untouched enabled-but-empty legacy row', () => {
      expect(() =>
        validateEntityFields(
          STORE,
          'update',
          { name: 'Nike' },
          { isFestiveOffer: true, festiveOfferTitle: '', festiveOfferDescription: '' },
          false,
        ),
      ).not.toThrow();
    });

    it('stops grandfathering as soon as the editor turns the toggle on', () => {
      // Touching the toggle in this payload makes the write ABOUT the festive
      // offer, so the empty fields are this save's problem.
      expect(() =>
        validateEntityFields(
          STORE,
          'update',
          { isFestiveOffer: true },
          { isFestiveOffer: false },
        ),
      ).toThrow(/festive offer title/);
    });

    it('strict blocks the same untouched enabled-but-empty legacy row', () => {
      expect(() =>
        validateEntityFields(
          BRAND,
          'update',
          { name: 'Nike' },
          { isFestiveOffer: true, festiveOfferTitle: '', festiveOfferDescription: '' },
          true,
        ),
      ).toThrow(/festive offer/);
    });
  });

  describe('strict ("clean as you touch") mode', () => {
    // In strict mode EVERY rule runs against the whole effective record (payload
    // merged over stored), so a dirty field the editor never touched blocks the
    // save. In non-strict mode (the cron path) behaviour is unchanged: an
    // untouched dirty field passes.

    it('rating: strict blocks an untouched out-of-range stored value', () => {
      expect(() =>
        validateEntityFields(STORE, 'update', { name: 'x' }, { ratingAverage: 7 }, true),
      ).toThrow(/Rating average/);
    });

    it('rating: non-strict passes the same untouched out-of-range stored value', () => {
      expect(() =>
        validateEntityFields(STORE, 'update', { name: 'x' }, { ratingAverage: 7 }, false),
      ).not.toThrow();
    });

    it('faq: strict blocks an untouched enabled-but-empty legacy state', () => {
      try {
        validateEntityFields(
          STORE,
          'update',
          { name: 'x' },
          { faqEnabled: true, faqs: [] },
          true,
        );
        throw new Error('expected to throw');
      } catch (err: any) {
        expect(err.details?.errors?.[0]?.path).toEqual(['faqs']);
      }
    });

    it('faq: non-strict grandfathers the same untouched enabled-but-empty state', () => {
      expect(() =>
        validateEntityFields(
          STORE,
          'update',
          { name: 'x' },
          { faqEnabled: true, faqs: [] },
          false,
        ),
      ).not.toThrow();
    });

    it('brand SEO: strict blocks an untouched blank stored SEO on a non-seo edit', () => {
      try {
        validateEntityFields(
          BRAND,
          'update',
          { name: 'x' },
          { seo: { metaTitle: '', metaDescription: null } },
          true,
        );
        throw new Error('expected to throw');
      } catch (err: any) {
        const paths = err.details?.errors?.map((e: any) => e.path.join('.'));
        expect(paths).toContain('seo.metaTitle');
        expect(paths).toContain('seo.metaDescription');
      }
    });

    it('brand SEO: non-strict skips SEO on the same non-seo edit', () => {
      expect(() =>
        validateEntityFields(
          BRAND,
          'update',
          { name: 'x' },
          { seo: { metaTitle: '', metaDescription: null } },
          false,
        ),
      ).not.toThrow();
    });

    it('strict still accepts a fully clean effective record', () => {
      expect(() =>
        validateEntityFields(
          BRAND,
          'update',
          { name: 'x' },
          {
            ratingAverage: 4.5,
            faqEnabled: false,
            seo: { metaTitle: 'Nike deals', metaDescription: 'Save on Nike' },
          },
          true,
        ),
      ).not.toThrow();
    });
  });

  it('collects problems across checks in one error', () => {
    try {
      validateEntityFields(BRAND, 'create', {
        ratingCount: 9999999999,
        faqEnabled: true,
        faqs: [],
      });
      throw new Error('expected to throw');
    } catch (err: any) {
      const paths = err.details?.errors?.map((e: any) => e.path.join('.'));
      expect(paths).toContain('ratingCount');
      expect(paths).toContain('faqs');
      expect(paths).toContain('seo.metaTitle');
    }
  });
});

describe('validateEntityFieldsForWrite', () => {
  it('loads stored values for a full-form update and applies grandfathering', async () => {
    const findOne = vi.fn().mockResolvedValue({
      ratingAverage: 7,
      faqEnabled: true,
      faqs: [],
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateEntityFieldsForWrite(
        strapi,
        STORE,
        'update',
        { ratingAverage: '7', faqEnabled: true, faqs: [] },
        'store-1',
      ),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('does not read for an unrelated partial update', async () => {
    const findOne = vi.fn();
    const strapi: any = { documents: () => ({ findOne }) };
    await validateEntityFieldsForWrite(
      strapi,
      STORE,
      'update',
      { name: 'Amazon' },
      'store-1',
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('strict reads the full record and blocks an untouched dirty field', async () => {
    const findOne = vi.fn().mockResolvedValue({ ratingAverage: 7 });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateEntityFieldsForWrite(strapi, STORE, 'update', { name: 'x' }, 'store-1', true),
    ).rejects.toThrow(/Rating average/);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('non-strict does not read for the same unrelated edit (cron path)', async () => {
    const findOne = vi.fn();
    const strapi: any = { documents: () => ({ findOne }) };

    await validateEntityFieldsForWrite(
      strapi,
      STORE,
      'update',
      { name: 'x' },
      'store-1',
      false,
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('loads the complete cross-field source for an empty brand clone', async () => {
    const findOne = vi.fn().mockResolvedValue({
      ratingCount: 5,
      ratingAverage: 4.5,
      faqEnabled: true,
      faqs: [{ question: 'Q?', answer: 'A' }],
      seo: {
        metaTitle: 'Nike deals',
        metaDescription: 'Save on Nike',
      },
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateEntityFieldsForWrite(
        strapi,
        BRAND,
        'clone',
        {},
        'brand-1',
      ),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'brand-1',
        fields: expect.arrayContaining([
          'ratingCount',
          'ratingAverage',
          'faqEnabled',
        ]),
        populate: expect.objectContaining({
          faqs: true,
          seo: { fields: ['metaTitle', 'metaDescription'] },
        }),
      }),
    );
  });
});
