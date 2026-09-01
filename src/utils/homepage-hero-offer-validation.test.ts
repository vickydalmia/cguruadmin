import { describe, expect, it, vi } from 'vitest';

import {
  homepageHeroEntityType,
  homepageHeroOfferTarget,
  normaliseHomepageHeroOfferFields,
} from './homepage-hero-offer';
import { validateHomepageHeroOffers } from './homepage-hero-offer-validation';

function harness(current: any = null) {
  const findOne = vi.fn(async () => current);
  return {
    strapi: {
      db: { query: vi.fn(() => ({ findOne })) },
    } as any,
    findOne,
  };
}

describe('Homepage Hero Offer consistency', () => {
  it('infers legacy Deal rows while keeping explicit Coupon rows authoritative', () => {
    const deal = { documentId: 'deal-1' };
    const coupon = { documentId: 'coupon-1' };
    expect(homepageHeroEntityType({ deal })).toBe('deal');
    expect(homepageHeroOfferTarget({ deal })).toBe(deal);
    expect(homepageHeroEntityType({ entityType: 'coupon', deal, coupon })).toBe(
      'coupon',
    );
    expect(homepageHeroOfferTarget({ entityType: 'coupon', deal, coupon })).toBe(
      coupon,
    );
  });

  it('clears the hidden relation and Deal-only image when the selector changes', () => {
    const data = {
      hero: {
        products: [
          {
            entityType: 'coupon',
            deal: { connect: [{ documentId: 'deal-1' }] },
            coupon: { connect: [{ documentId: 'coupon-1' }] },
            imageOverride: { id: 9 },
          },
          {
            entityType: 'deal',
            deal: { connect: [{ documentId: 'deal-2' }] },
            coupon: { connect: [{ documentId: 'coupon-2' }] },
          },
        ],
      },
    };

    normaliseHomepageHeroOfferFields(data);

    expect(data.hero.products[0]).toMatchObject({
      deal: null,
      coupon: { connect: [{ documentId: 'coupon-1' }] },
      imageOverride: null,
    });
    expect(data.hero.products[1]).toMatchObject({
      deal: { connect: [{ documentId: 'deal-2' }] },
      coupon: null,
    });
  });

  it('accepts one matching relation for each entity type', async () => {
    const { strapi } = harness();
    await expect(
      validateHomepageHeroOffers(strapi, {
        hero: {
          products: [
            { entityType: 'deal', deal: { documentId: 'deal-1' } },
            { entityType: 'coupon', coupon: { documentId: 'coupon-1' } },
          ],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('reports the relevant picker when the selected type has no relation', async () => {
    const { strapi } = harness();
    const error = await validateHomepageHeroOffers(strapi, {
      hero: {
        products: [
          { entityType: 'deal', deal: null },
          { entityType: 'coupon', coupon: null },
        ],
      },
    }).catch((value) => value);

    expect(error.details.errors).toEqual([
      expect.objectContaining({ path: ['hero', 'products', 0, 'deal'] }),
      expect.objectContaining({ path: ['hero', 'products', 1, 'coupon'] }),
    ]);
  });

  it('resolves untouched relation patches against the stored component row', async () => {
    const { strapi } = harness({
      hero: {
        products: [
          {
            id: 7,
            entityType: 'coupon',
            coupon: { documentId: 'coupon-7' },
          },
        ],
      },
    });

    await expect(
      validateHomepageHeroOffers(strapi, {
        hero: {
          products: [{ id: 7, entityType: 'coupon', titleOverride: 'Weekend' }],
        },
      }),
    ).resolves.toBeUndefined();
  });
});
