import { describe, expect, it } from 'vitest';
import { collectTranslatableLeaves } from './field-map';
import { heroOfferIdentityName } from './hero-offer-identity';
import { translationPopulate } from './populate';
import { validateTranslatedBatch } from './validate';

const models: Record<string, any> = {
  'api::homepage.homepage': require('../api/homepage/content-types/homepage/schema.json'),
  'home.hero-section': require('../components/home/hero-section.json'),
  'home.hero-product': require('../components/home/hero-product.json'),
};
const strapi = { getModel: (uid: string) => models[uid] ?? { attributes: {} } } as any;
const store = { documentId: 'sun-sand', name: 'Sun And Sand Sports' };
const brand = { documentId: 'ninja', name: 'Ninja Kitchen' };
const coupon = { documentId: 'coupon-1', stores: [store], brands: [] };
const deal = { documentId: 'deal-1', stores: [], brands: [brand] };
const arabic = /\p{Script=Arabic}/u;

describe('homepage hero offer identity', () => {
  it('accepts the reported store and brand titles through real homepage schemas', () => {
    const leaves = collectTranslatableLeaves(strapi, 'api::homepage.homepage', {
      hero: { products: [
        { entityType: 'coupon', coupon, titleOverride: store.name },
        { entityType: 'deal', deal, titleOverride: brand.name },
      ] },
    });
    expect(leaves.map((leaf) => leaf.linkedOfferName)).toEqual([store.name, brand.name]);
    expect(validateTranslatedBatch(leaves,
      Object.fromEntries(leaves.map((leaf) => [leaf.path, leaf.value])), arabic)).toEqual([]);
    expect(leaves.every((leaf) => leaf.note?.includes('official store or brand name'))).toBe(true);
    expect(validateTranslatedBatch([leaves[1]], {
      [leaves[1].path]: 'Different Kitchen',
    }, arabic)).toEqual([expect.objectContaining({ problems: ['target-language-missing'] })]);
  });

  it.each(['Save 30% at Ninja Kitchen', 'Ninja Kitchen Offers', 'Sale', 'Unrelated Brand'])(
    'continues rejecting untranslated promotional or unmatched text: %s', (titleOverride) => {
      const leaves = collectTranslatableLeaves(strapi, 'api::homepage.homepage', {
        hero: { products: [{ entityType: 'deal', deal, titleOverride }] },
      });
      expect(leaves[0].linkedOfferName).toBeUndefined();
      expect(validateTranslatedBatch(leaves, { [leaves[0].path]: titleOverride }, arabic))
        .toEqual([expect.objectContaining({ problems: ['untranslated-source', 'target-language-missing'] })]);
    },
  );

  it('uses only the selected backend entity, including the schema default', () => {
    expect(heroOfferIdentityName({ entityType: 'coupon', coupon, deal }, brand.name)).toBeUndefined();
    expect(heroOfferIdentityName({ entityType: 'deal', coupon, deal }, store.name)).toBeUndefined();
    expect(heroOfferIdentityName({ deal }, brand.name)).toBe(brand.name);
    expect(heroOfferIdentityName({ entityType: 'unknown', deal }, brand.name)).toBeUndefined();
  });

  it('requires populated entity identities rather than a free-text title or URL', () => {
    expect(heroOfferIdentityName({ titleOverride: brand.name, url: '/ninja/' }, brand.name)).toBeUndefined();
    expect(heroOfferIdentityName({ deal: { brands: [brand] } }, brand.name)).toBeUndefined();
    expect(heroOfferIdentityName({ deal: { documentId: 'deal', brands: [{ name: brand.name }] } }, brand.name)).toBeUndefined();
  });

  it('does not exempt ordinary text through the legacy identity flag or on other paths', () => {
    for (const leaf of [
      { path: 'hero.products.0.titleOverride', identity: true },
      { path: 'hero.heading', linkedOfferName: brand.name },
    ]) {
      expect(validateTranslatedBatch([{ ...leaf, kind: 'plain', value: brand.name }], {
        [leaf.path]: brand.name,
      }, arabic)).toHaveLength(1);
    }
  });

  it('loads only the linked offers’ store/brand names without inverse collections', () => {
    const populate = translationPopulate(strapi, 'api::homepage.homepage') as any;
    const products = populate.hero.populate.products.populate;
    for (const entityType of ['coupon', 'deal']) {
      expect(products[entityType]).toEqual({ populate: {
        stores: { fields: ['name'] }, brands: { fields: ['name'] },
      } });
    }
  });
});
