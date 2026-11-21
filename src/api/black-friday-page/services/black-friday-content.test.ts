import { describe, expect, it } from 'vitest';
import { addCampaignCategoryRows, blackFridayDealCategorySlug, curatedCategoryRows, limitAutomaticCoupons, limitListingDeals, selectCampaignCategories } from './black-friday-content';

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
  it('limits automatic categories and keeps editor selections complete', () => {
    const curatedRow = { coupons: offers(5) };
    const automaticRow: any = { coupons: [] };
    const section = { categories: [curatedRow, automaticRow] };
    const curated = curatedCategoryRows(section);
    automaticRow.coupons = offers(5);
    curatedRow.coupons = offers(5);
    limitAutomaticCoupons(section, curated, 2);
    expect([curatedRow.coupons.length, automaticRow.coupons.length]).toEqual([5, 2]);
  });
  it('keeps the newest Deals per selected category', () => {
    const deal = (documentId: string, category: string) => ({ documentId, categories: [{ documentId: category }, { documentId: 'other' }] });
    const section = { categories: [{ category: { documentId: 'a' } }, { category: { documentId: 'b' } }], listingDeals: [deal('1', 'a'), deal('2', 'a'), deal('3', 'b'), deal('4', 'a')] };
    limitListingDeals(section, 2);
    expect(section.listingDeals.map((item) => item.documentId)).toEqual(['1', '2', '3']);
  });
});
