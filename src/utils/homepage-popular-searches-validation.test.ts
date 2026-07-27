import { describe, expect, it, vi } from 'vitest';
import { validateHomepagePopularSearches } from './homepage-popular-searches-validation';

function harness(storedPopularSearches: any = null) {
  const findOne = vi.fn().mockResolvedValue({
    documentId: 'homepage-1',
    popularSearches: storedPopularSearches,
  });
  const strapi = {
    documents: vi.fn(() => ({ findOne })),
  } as any;
  return { strapi, findOne };
}

describe('homepage Popular Searches validation', () => {
  it('allows the section to be switched off with no selections', async () => {
    const { strapi, findOne } = harness();
    await expect(
      validateHomepagePopularSearches(strapi, {
        popularSearches: {
          enabled: false,
          stores: [],
          brands: [],
          categories: [],
          banks: [],
        },
      }),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects save when enabled with every entity dropdown empty', async () => {
    const { strapi } = harness();
    const error = await validateHomepagePopularSearches(strapi, {
      popularSearches: {
        enabled: true,
        stores: [],
        brands: [],
        categories: [],
        banks: [],
      },
    }).catch((value) => value);

    expect(error.message).toMatch(/Select at least one Store, Brand, Category, or Bank/u);
    expect(error.details.errors[0].path).toEqual([
      'popularSearches',
      'stores',
    ]);
  });

  it.each(['stores', 'brands', 'categories', 'banks'] as const)(
    'accepts an enabled section with a selected %s entity',
    async (field) => {
      const { strapi } = harness();
      await expect(
        validateHomepagePopularSearches(strapi, {
          popularSearches: {
            enabled: true,
            stores: [],
            brands: [],
            categories: [],
            banks: [],
            [field]: [{ documentId: `${field}-1` }],
          },
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('resolves relation patches against the stored selection', async () => {
    const stored = {
      stores: [{ documentId: 'store-1' }],
      brands: [],
      categories: [],
      banks: [],
    };
    const { strapi, findOne } = harness(stored);

    await expect(
      validateHomepagePopularSearches(
        strapi,
        {
          popularSearches: {
            enabled: true,
            stores: { disconnect: [{ documentId: 'store-1' }] },
          },
        },
        'homepage-1',
      ),
    ).rejects.toThrow(/Select at least one Store/u);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'homepage-1' }),
    );
  });

  it('keeps an untouched stored selection valid on a partial component update', async () => {
    const { strapi } = harness({
      stores: [],
      brands: [],
      categories: [],
      banks: [{ documentId: 'bank-1' }],
    });
    await expect(
      validateHomepagePopularSearches(
        strapi,
        { popularSearches: { enabled: true, heading: 'Popular Searches' } },
        'homepage-1',
      ),
    ).resolves.toBeUndefined();
  });
});
