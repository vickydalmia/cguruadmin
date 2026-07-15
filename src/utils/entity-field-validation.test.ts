import { describe, expect, it } from 'vitest';
import { validateEntityFields } from './entity-field-validation';

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

    it('does not enforce SEO on non-brand taxonomies', () => {
      expect(() =>
        validateEntityFields(STORE, 'create', { name: 'Amazon' })
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
