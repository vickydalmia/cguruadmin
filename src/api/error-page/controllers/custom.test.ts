import { describe, expect, it } from 'vitest';
import { mapErrorPage, safeUrl } from './custom';

describe('error page aggregate mapping', () => {
  it('returns the complete Figma fallback for a missing entry', () => {
    const value = mapErrorPage(null);
    expect(value.hero.ticketTitle).toBe('OOPS!');
    expect(value.hero.heading).toBe('Page not found');
    expect(value.explore.storesCard.mobileTitle).toBe('Global Exposure');
    expect(value.hero.searchButtonLabel).toBe('Search');
    expect(value.explore.electronicsCard.ctaLabel).toBe('View Deals');
    expect(value.trustBanner.ctaLabel).toBe('Explore Deals');
  });

  it('trims overrides, preserves the fixed ticket title, and sanitizes URLs', () => {
    const value = mapErrorPage({
      hero: {
        ticketTitle: 'editor cannot change this',
        heading: '  Custom heading  ',
        homeCta: { label: ' Home ', url: 'javascript:alert(1)' },
      },
      explore: {
        storesCard: {
          title: ' Stores ',
          mobileTitle: ' Mobile stores ',
          url: 'https://example.com/stores',
        },
      },
    });

    expect(value.hero.ticketTitle).toBe('OOPS!');
    expect(value.hero.heading).toBe('Custom heading');
    expect(value.hero.homeCta).toEqual({ label: 'Home', url: '/' });
    expect(value.explore.storesCard.mobileTitle).toBe('Mobile stores');
    expect(value.explore.storesCard.url).toBe('https://example.com/stores');
  });

  it('allows only root-relative and http(s) destinations', () => {
    expect(safeUrl('/stores/', '/')).toBe('/stores/');
    expect(safeUrl('//evil.example', '/')).toBe('/');
    expect(safeUrl('data:text/html,boom', '/')).toBe('/');
    expect(safeUrl('https://couponzguru.com', '/')).toBe('https://couponzguru.com/');
  });
});
