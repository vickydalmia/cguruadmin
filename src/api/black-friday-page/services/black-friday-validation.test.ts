import { describe, expect, it } from 'vitest';
import { blackFridayPageProblems, isSafeBlackFridayLink } from './black-friday-validation';

describe('Black Friday validation', () => {
  it('accepts root-relative and HTTP(S) links only', () => {
    expect(isSafeBlackFridayLink('/stores/')).toBe(true);
    expect(isSafeBlackFridayLink('https://example.com/sale')).toBe(true);
    expect(isSafeBlackFridayLink('//evil.example')).toBe(false);
    expect(isSafeBlackFridayLink('javascript:alert(1)')).toBe(false);
  });
  it('addresses each invalid input', () => {
    expect(blackFridayPageProblems({ hero: { primaryCtaHref: 'javascript:x', saleEndAt: 'soon' }, featured: { viewAllHref: '//x' } }).map((p) => p.path.join('.'))).toEqual(['hero.primaryCtaHref', 'featured.viewAllHref', 'hero.saleEndAt']);
  });
  it('allows optional empty sections', () => expect(blackFridayPageProblems({ enabled: true })).toEqual([]));
});
