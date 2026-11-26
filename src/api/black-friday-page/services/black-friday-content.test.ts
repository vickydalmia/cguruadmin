import { describe, expect, it, vi } from 'vitest';
import { addCampaignCategoryRows, applyCategoryCouponOrders, blackFridayDealCategorySlug, curatedCategoryRows, limitListingDeals, loadCategoryCouponOrders, selectCampaignCategories } from './black-friday-content';

const offers = (count: number) => Array.from({ length: count }, (_, index) => ({ documentId: `offer-${index}` }));

describe('Black Friday campaign categories', () => {
  it('adds hidden filter rows without duplicating an editor-selected category', () => {
    const section: any = { categories: [{ category: { documentId: 'bf', slug: 'black-friday-coupons' } }] };
    addCampaignCategoryRows(section, selectCampaignCategories([{ documentId: 'bf', slug: 'black-friday-coupons' }, { documentId: 'cm', slug: 'cyber-monday-coupons' }, { documentId: 'x', slug: 'other' }]));
    expect(section.categories.map((row: any) => [row.category.documentId, row.campaign, row.campaignOnly])).toEqual([['bf', 'black-friday', undefined], ['cm', 'cyber-monday', true]]);
  });

  it('resolves each country slug and prefers the category using the template', () => {
    const usa = selectCampaignCategories([{ documentId: 'cm', slug: 'cyber-monday-coupons' }, { documentId: 'bf', slug: 'blackfriday-coupons' }]);
    expect(usa.map(({ campaign, category }) => [campaign, category.slug])).toEqual([['black-friday', 'blackfriday-coupons'], ['cyber-monday', 'cyber-monday-coupons']]);
    expect(blackFridayDealCategorySlug(usa)).toBe('blackfriday-coupons');
    const assigned = selectCampaignCategories([{ documentId: 'old', slug: 'black-friday-coupons' }, { documentId: 'sale', slug: 'november-sale', pageTemplate: 'blackFridayTemplate' }]);
    expect(assigned).toEqual([{ campaign: 'black-friday', category: { documentId: 'sale', slug: 'november-sale' } }]);
  });

  it('keeps Cyber Monday separate and never widens the Deal filter', () => {
    const cyber = selectCampaignCategories([{ documentId: 'cm', slug: 'cyber-monday-coupons', pageTemplate: 'blackFridayTemplate' }]);
    expect(cyber.map(({ campaign }) => campaign)).toEqual(['cyber-monday']);
    expect(blackFridayDealCategorySlug(cyber)).toBe('black-friday-coupons');
    expect(blackFridayDealCategorySlug([])).toBe('black-friday-coupons');
  });
});

describe('Black Friday listing limits', () => {
  it('keeps every automatic Coupon after applying the saved order', () => {
    const row: any = { category: { documentId: 'bf' }, coupons: offers(30) };
    const section = { categories: [row] };
    applyCategoryCouponOrders(section, new Set(), new Map([['bf', ['offer-29', 'missing', 'offer-5', 'offer-29']]]));
    expect(row.coupons.slice(0, 3).map((coupon: any) => coupon.documentId)).toEqual(['offer-29', 'offer-5', 'offer-0']);
    expect(row.coupons).toHaveLength(30);
  });
  it('does not override coupons picked in the template', () => {
    const row: any = { category: { documentId: 'bf' }, coupons: offers(3) };
    const section = { categories: [row] };
    applyCategoryCouponOrders(section, new Set([row]), new Map([['bf', ['offer-2']]]));
    expect(row.coupons[0].documentId).toBe('offer-0');
  });
  it('loads Top Picks before Ordered Coupons for automatic categories only', async () => {
    const automatic = { category: { documentId: 'bf' } };
    const picked = { category: { documentId: 'picked' } };
    const findMany = vi.fn().mockResolvedValue([{ documentId: 'bf', topPickCoupons: [{ documentId: 'top' }], orderedCoupons: [{ documentId: 'next' }] }]);
    const orders = await loadCategoryCouponOrders({ documents: () => ({ findMany }) }, { categories: [automatic, picked] }, new Set([picked]), 'ar');
    expect(orders.get('bf')).toEqual(['top', 'next']);
    expect(findMany.mock.calls[0][0]).toMatchObject({ locale: 'ar', filters: { documentId: { $in: ['bf'] } } });
  });
  it('keeps the newest Deals per selected category', () => {
    const deal = (documentId: string, category: string) => ({ documentId, categories: [{ documentId: category }, { documentId: 'other' }] });
    const section = { categories: [{ category: { documentId: 'a' } }, { category: { documentId: 'b' } }], listingDeals: [deal('1', 'a'), deal('2', 'a'), deal('3', 'b'), deal('4', 'a')] };
    limitListingDeals(section, 2);
    expect(section.listingDeals.map((item) => item.documentId)).toEqual(['1', '2', '3']);
  });
});
