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

  // The old rule blocked < and > but allowed quotes, while its own message
  // promised to reject "markup". `/x" onload="…/` therefore reached
  // seo.canonical, where any unescaped href interpolation makes it an
  // attribute-injection payload.
  it.each([
    ['/x" onload="alert(1)/', 'double quote'],
    ["/x' onload='alert(1)/", 'single quote'],
    ['/x`y/', 'backtick'],
    ['/x<script>/', 'angle brackets'],
    ['//evil.example.com/', 'protocol-relative'],
    ['/x?a=1', 'query'],
    ['/x#frag', 'fragment'],
    ['/x\\y', 'backslash'],
    ['https://example.com/x/', 'absolute URL'],
    ['x/y/', 'not root-relative'],
  ])('rejects canonical %s (%s)', (canonicalUrl) => {
    expect(() =>
      validateEntityDealPageSeo('api::store.store', {
        entityDealPageSeo: { canonicalUrl },
      }),
    ).toThrow(/validation problem/);
  });

  it('rejects angle brackets in the SEO text fields', () => {
    for (const field of [
      'metaTitle',
      'metaDescription',
      'ogTitle',
      'ogDescription',
      'ogImageAlt',
    ]) {
      expect(() =>
        validateEntityDealPageSeo('api::store.store', {
          entityDealPageSeo: { [field]: 'Deals <script>alert(1)</script>' },
        }),
      ).toThrow(/validation problem/);
    }
  });

  it('accepts only a media reference or null for ogImage', () => {
    for (const ogImage of [7, { id: 7 }, null]) {
      expect(() =>
        validateEntityDealPageSeo('api::store.store', {
          entityDealPageSeo: { ogImage },
        }),
      ).not.toThrow();
    }

    for (const ogImage of ['7', 0, -3, 1.5, {}, { id: 'x' }, [], true]) {
      expect(() =>
        validateEntityDealPageSeo('api::store.store', {
          entityDealPageSeo: { ogImage },
        }),
      ).toThrow(/validation problem/);
    }
  });
});
