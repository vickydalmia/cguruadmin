import { describe, expect, it } from 'vitest';
import { buildDealComputedContent } from './deal-computed-content';

describe('buildDealComputedContent', () => {
  it('renders price (bold), MRP and discount lines', () => {
    expect(
      buildDealComputedContent({ salePrice: '1299.00', mrp: 2999, discount: '56% OFF' }),
    ).toBe(
      '<p><strong>Deal Price - ₹1,299</strong></p>' +
        '<p>MRP - ₹2,999</p>' +
        '<p>Discount - 56% OFF</p>',
    );
  });

  it('skips lines with no data', () => {
    expect(buildDealComputedContent({ salePrice: 499 })).toBe(
      '<p><strong>Deal Price - ₹499</strong></p>',
    );
    expect(buildDealComputedContent({ discount: 'Buy one get one' })).toBe(
      '<p>Discount - Buy one get one</p>',
    );
    expect(buildDealComputedContent({ salePrice: null, mrp: 0, discount: '  ' })).toBeNull();
    expect(buildDealComputedContent({})).toBeNull();
  });

  it('keeps decimals and uses en-IN grouping', () => {
    expect(buildDealComputedContent({ salePrice: '99999.50' })).toBe(
      '<p><strong>Deal Price - ₹99,999.5</strong></p>',
    );
  });

  it('escapes HTML in the free-text discount', () => {
    expect(buildDealComputedContent({ discount: '<b>50%</b>' })).toBe(
      '<p>Discount - &lt;b&gt;50%&lt;/b&gt;</p>',
    );
  });

  it('ignores malformed amounts', () => {
    expect(buildDealComputedContent({ salePrice: 'abc', mrp: -5 })).toBeNull();
  });
});
