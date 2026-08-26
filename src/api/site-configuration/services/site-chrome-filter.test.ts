import { describe, expect, it } from 'vitest';

import { filterSiteChrome } from './site-chrome-filter';

const feature = (live: boolean) => ({ enabled: live, ready: live, live });

describe('site chrome feature filtering', () => {
  it('removes disabled static, relation-backed and offer links', () => {
    const features: any = {
      stores: feature(false),
      categories: feature(false),
      careers: feature(false),
      coupons: feature(false),
      productDeals: feature(false),
      partnerWithUs: feature(false),
    };
    const result = filterSiteChrome(
      {
        topStores: [{ name: 'Store' }],
        categorySections: [{ category: { slug: 'fashion' }, links: [] }],
        extraItems: [
          { label: 'Careers', url: '/careers/' },
          { label: 'Coupon', url: '/coupon/1/' },
          { label: 'Home', url: '/' },
        ],
      },
      {
        partnerCard: { heading: 'Join us' },
        sections: [{ links: [{ url: '/stores/' }, { url: '/' }] }],
      },
      features,
    );
    expect(result.menu.topStores).toEqual([]);
    expect(result.menu.categorySections).toEqual([]);
    expect(result.menu.extraItems).toEqual([{ label: 'Home', url: '/' }]);
    expect(result.footer.partnerCard).toBeNull();
    expect(result.footer.sections[0].links).toEqual([{ url: '/' }]);
  });

  it('filters campaign links by the selected entity template, not its slug', () => {
    const features: any = {
      stores: feature(true),
      categories: feature(true),
      dealOfTheDay: feature(false),
      independenceDaySale: feature(true),
      partnerWithUs: feature(true),
    };
    const result = filterSiteChrome(
      {
        topStores: [],
        categorySections: [],
        extraItems: [
          {
            label: 'Daily Specials',
            category: { slug: 'daily-specials', pageTemplate: 'dealTemplate' },
          },
          {
            label: 'Freedom Sale',
            category: {
              slug: 'freedom-sale',
              pageTemplate: 'independenceDayTemplate',
            },
          },
        ],
      },
      null,
      features,
    );

    expect(result.menu.extraItems).toEqual([
      {
        label: 'Freedom Sale',
        category: {
          slug: 'freedom-sale',
          pageTemplate: 'independenceDayTemplate',
        },
      },
    ]);
  });
});
