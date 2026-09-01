import { describe, expect, it, vi } from 'vitest';

import { HOMEPAGE_POPULAR_REGULAR_LIMIT } from '../constants/homepage-sections';
import { validateHomepagePopularStores } from './homepage-popular-stores-validation';

const entities = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    documentId: `${prefix}-${index}`,
  }));

function harness(storedPopularStores: any = null) {
  const findOne = vi.fn().mockResolvedValue({
    documentId: 'homepage-1',
    popularStores: storedPopularStores,
  });
  const strapi = {
    documents: vi.fn(() => ({ findOne })),
  } as any;
  return { strapi, findOne };
}

describe('homepage Popular Stores & Brands validation', () => {
  it('accepts 30 regular Store and Brand selections plus a featured entity', async () => {
    const { strapi, findOne } = harness();
    await expect(
      validateHomepagePopularStores(strapi, {
        popularStores: {
          featuredEntityType: 'brand',
          featuredBrand: { documentId: 'featured-brand' },
          stores: entities('store', 18),
          brands: entities('brand', 12),
        },
      }),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects 31 regular selections even when each relation is independently below 30', async () => {
    const { strapi } = harness();
    const error = await validateHomepagePopularStores(strapi, {
      popularStores: {
        stores: entities('store', 20),
        brands: entities('brand', 11),
      },
    }).catch((value) => value);

    expect(error.message).toContain(
      `at most ${HOMEPAGE_POPULAR_REGULAR_LIMIT} regular selections`,
    );
    expect(error.message).toContain('remove 1 selection');
    expect(error.details.errors[0].path).toEqual([
      'popularStores',
      'stores',
    ]);
  });

  it('resolves relation connect and disconnect patches against the stored lists', async () => {
    const { strapi, findOne } = harness({
      stores: entities('store', 20),
      brands: entities('brand', 10),
    });

    await expect(
      validateHomepagePopularStores(
        strapi,
        {
          popularStores: {
            stores: {
              disconnect: [{ documentId: 'store-0' }],
            },
            brands: {
              connect: [
                { documentId: 'brand-10' },
                { documentId: 'brand-11' },
              ],
            },
          },
        },
        'homepage-1',
      ),
    ).rejects.toThrow(/You selected 31; remove 1 selection/u);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'homepage-1' }),
    );
  });

  it('keeps an untouched stored relation in the combined count', async () => {
    const { strapi } = harness({
      stores: entities('store', 20),
      brands: entities('brand', 10),
    });

    await expect(
      validateHomepagePopularStores(
        strapi,
        {
          popularStores: {
            stores: { disconnect: [{ documentId: 'store-0' }] },
          },
        },
        'homepage-1',
      ),
    ).resolves.toBeUndefined();
  });
});
