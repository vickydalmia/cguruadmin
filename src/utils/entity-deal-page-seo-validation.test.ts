import { describe, expect, it } from 'vitest';

import { validateEntityDealPageSeo } from './entity-deal-page-seo-validation';

describe('validateEntityDealPageSeo', () => {
  it('does not inspect unrelated writes or content types', () => {
    expect(() =>
      validateEntityDealPageSeo('api::store.store', { name: 'Amazon' }),
    ).not.toThrow();
    expect(() =>
      validateEntityDealPageSeo('api::deal.deal', {
        entityDealPageSeo: { indexingEnabled: 'yes' },
      }),
    ).not.toThrow();
  });

  it('accepts a complete root-relative SEO configuration', () => {
    expect(() =>
      validateEntityDealPageSeo('api::category.category', {
        entityDealPageSeo: {
          indexingEnabled: true,
          metaTitle: 'Mobile Deals & Offers',
          metaDescription: 'Current mobile product deals.',
          canonicalUrl: '/mobile-deals/',
          ogTitle: 'Mobile deals',
          ogDescription: 'Current mobile product deals.',
          ogImageAlt: 'Mobile deals',
        },
      }),
    ).not.toThrow();
  });

  it('collects typed field and canonical problems with nested paths', () => {
    let caught: any;
    try {
      validateEntityDealPageSeo('api::bank.bank', {
        entityDealPageSeo: {
          indexingEnabled: 'yes',
          metaTitle: 'x'.repeat(71),
          canonicalUrl: 'https://example.com/hdfc-deals/',
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught?.name).toBe('ValidationError');
    expect(caught?.details?.errors.map((item: any) => item.path)).toEqual([
      ['entityDealPageSeo', 'indexingEnabled'],
      ['entityDealPageSeo', 'metaTitle'],
      ['entityDealPageSeo', 'canonicalUrl'],
    ]);
  });
});
