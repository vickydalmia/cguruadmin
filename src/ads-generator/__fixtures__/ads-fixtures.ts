// Shared test inputs for src/ads-generator/*.test.ts.
import type { AdsGeneratorFormInput } from '../../constants/ads-generator';
import type { AdsForm } from '../form';
import type { AdsModelOutput } from '../prompt/output-schema';

export function formInput(overrides: Partial<AdsGeneratorFormInput> = {}): AdsGeneratorFormInput {
  return {
    adType: 'offer',
    campaignName: 'Test Myntra',
    brandName: 'Myntra',
    countries: 'India, UAE, USA',
    landingPage: 'https://www.couponzguru.com/myntra-coupons/',
    dailyBudget: '5000',
    targetCpa: '15',
    label: 'VK Label',
    mobileAdjustment: '-50',
    tabletAdjustment: '',
    desktopAdjustment: '0',
    negativeKeywordLists: 'Brand restricted',
    offerDetails: 'Flat 40% off on shoes. Minimum order 999. Extra 10% with code STYLE10.',
    brandCategories: '',
    ...overrides,
  };
}

export function parsedForm(overrides: Partial<AdsForm> = {}): AdsForm {
  return {
    adType: 'offer',
    campaignName: 'Test Myntra',
    brandName: 'Myntra',
    countries: ['India', 'United Arab Emirates', 'United States'],
    landingPage: 'https://www.couponzguru.com/myntra-coupons/',
    dailyBudget: 5000,
    targetCpa: 15,
    label: 'VK Label',
    mobileAdjustment: -50,
    tabletAdjustment: null,
    desktopAdjustment: 0,
    negativeKeywordLists: ['Brand restricted'],
    offerDetails: 'Flat 40% off on shoes. Minimum order 999. Extra 10% with code STYLE10.',
    brandCategories: [],
    ...overrides,
  };
}

export function evergreenFormInput(overrides: Partial<AdsGeneratorFormInput> = {}): AdsGeneratorFormInput {
  return formInput({ adType: 'evergreen', offerDetails: '', brandCategories: 'Fashion, shoes, ethnic wear, beauty', ...overrides });
}

export function evergreenForm(overrides: Partial<AdsForm> = {}): AdsForm {
  return parsedForm({
    adType: 'evergreen', offerDetails: '', brandCategories: ['Fashion', 'shoes', 'ethnic wear', 'beauty'], ...overrides,
  });
}

// Passes every mechanical rule (headlines 24-30, descriptions 72-90, full brand
// in >= 5 of 10 headlines) AND every editorial rule (brand in <= 7 headlines /
// <= 2 descriptions, <= 5 coupon headlines, one CouponzGuru description, no
// filler; >= 3 brand + offer headlines: 6, 8 and 9). The brand sits in
// headlines 1, 3, 6, 8, 9 and 10, so tests that replace one of headlines 2-8
// still leave at least five.
const AD_ONE = {
  headlines: [
    'Myntra Coupons & Discounts',
    'Flat 40% Off On Shoes, Min 999',
    'Myntra Shoe Coupon Codes',
    'Extra 10% Off With STYLE10',
    'Save More On Your Shoe Order',
    'Myntra Shoes: Flat 40% Off',
    'Sneakers, Sandals And Boots',
    'Myntra Extra 10% With STYLE10',
    'Myntra Shoe Offers Over 999',
    'Use Myntra Discount Coupons',
  ],
  descriptions: [
    'Get flat 40% off on shoes at Myntra with these coupons. Orders from 999 qualify for it.',
    'Use code STYLE10 at checkout for an extra 10% off your shoe order on the sale price.',
    'Pick sneakers, sandals or boots and apply the code before you pay to cut your final total.',
    'CouponzGuru keeps current shoe coupons together so you can pick one and save on footwear.',
  ],
};


export function validOutput(overrides: Partial<AdsModelOutput> = {}): AdsModelOutput {
  return {
    status: 'ready',
    reason: '',
    ads: [structuredClone(AD_ONE)],
    warnings: [],
    ...overrides,
  };
}

// Evergreen copy: no numbers, codes, dates or events; same editorial limits.
const EVERGREEN_AD_ONE = {
  headlines: [
    'Myntra Coupons & Discounts',
    'Save On Shoes And Ethnic Wear',
    'Myntra Coupon Codes For Shoes',
    'Fashion Savings With A Code',
    'Apply A Coupon At Checkout',
    'Myntra Ethnic Wear Discounts',
    'Lower Prices On Footwear',
    'Myntra Beauty Offers And Deals',
    'Myntra Fashion Deals & Offers',
    'Myntra Discount Coupon Codes',
  ],
  descriptions: [
    'Find Myntra coupons for fashion, shoes and beauty, then apply one before you check out.',
    'Pick a coupon that fits your shoe or ethnic wear order and use it at checkout to save.',
    'Compare the available fashion and beauty offers and choose the one that suits your cart.',
    'CouponzGuru lists current coupons and deals, so you can save on your next fashion order.',
  ],
};


export function evergreenOutput(overrides: Partial<AdsModelOutput> = {}): AdsModelOutput {
  return {
    status: 'ready',
    reason: '',
    ads: [structuredClone(EVERGREEN_AD_ONE)],
    warnings: [],
    ...overrides,
  };
}
