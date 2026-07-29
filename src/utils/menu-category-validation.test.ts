import { describe, expect, it, vi } from 'vitest';

import { validateMenuCategorySections } from './menu-category-validation';

function harness(storedSections: any[] = []) {
  const findOne = vi.fn().mockResolvedValue({
    documentId: 'menu-1',
    categorySections: storedSections,
  });
  return {
    strapi: {
      documents: vi.fn(() => ({ findOne })),
    } as any,
    findOne,
  };
}

describe('menu category section validation', () => {
  it('accepts a Category-backed group without an override icon', async () => {
    const { strapi } = harness();
    await expect(
      validateMenuCategorySections(strapi, {
        categorySections: [
          {
            title: 'Fashion',
            category: { documentId: 'category-1' },
            icon: null,
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('requires a destination and icon for a custom group', async () => {
    const { strapi } = harness();
    const error = await validateMenuCategorySections(strapi, {
      categorySections: [{ title: 'Top Offers', url: '', icon: null }],
    }).catch((value) => value);

    expect(
      error.details.errors.map((entry: any) => entry.path.join('.')),
    ).toEqual([
      'categorySections.0.category',
      'categorySections.0.icon',
    ]);
  });

  it('accepts a custom URL group with an uploaded icon', async () => {
    const { strapi } = harness();
    await expect(
      validateMenuCategorySections(strapi, {
        categorySections: [
          {
            title: 'Top Offers',
            url: '/deal-of-the-day/',
            icon: { id: 7 },
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves partial component relation patches against stored data', async () => {
    const { strapi, findOne } = harness([
      {
        id: 5,
        title: 'Fashion',
        url: null,
        category: { documentId: 'category-1' },
        icon: null,
      },
    ]);

    await expect(
      validateMenuCategorySections(
        strapi,
        {
          categorySections: [
            {
              id: 5,
              title: 'New Fashion',
            },
          ],
        },
        'menu-1',
      ),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'menu-1' }),
    );
  });
});
