import { describe, expect, it, vi } from 'vitest';
import {
  resultingRelationCount,
  validateDealOfTheDaySectionLimits,
} from './deal-of-the-day-validation';

function strapiWithCurrent(current: any = {}) {
  const findOne = vi.fn().mockResolvedValue(current);
  return {
    strapi: { db: { query: vi.fn(() => ({ findOne })) } } as any,
    findOne,
  };
}

describe('Deal of the Day section limits', () => {
  it('resolves direct, set, and connect/disconnect relation counts', () => {
    expect(resultingRelationCount([{ id: 1 }, { id: 2 }, { id: 2 }])).toBe(2);
    expect(resultingRelationCount({ set: [{ documentId: 'a' }] })).toBe(1);
    expect(
      resultingRelationCount(
        {
          disconnect: [{ id: 1 }],
          connect: [{ documentId: 'c' }, { documentId: 'd' }],
        },
        [
          { id: 1, documentId: 'a' },
          { id: 2, documentId: 'b' },
          { id: 3, documentId: 'c' },
        ]
      )
    ).toBe(3);
  });

  it('accepts the exact 4/6/6 authoring buffers', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateDealOfTheDaySectionLimits(strapi, {
        topPicks: { deals: Array.from({ length: 4 }, (_, id) => ({ id })) },
        smartSavingStack: {
          deals: Array.from({ length: 6 }, (_, id) => ({ id: id + 10 })),
        },
        genZDrops: {
          deals: Array.from({ length: 6 }, (_, id) => ({ id: id + 20 })),
        },
      })
    ).resolves.toBeUndefined();
  });

  it('rejects every over-limit section with an inline field path', async () => {
    const { strapi } = strapiWithCurrent();

    try {
      await validateDealOfTheDaySectionLimits(strapi, {
        topPicks: { deals: Array.from({ length: 5 }, (_, id) => ({ id })) },
        smartSavingStack: {
          deals: Array.from({ length: 7 }, (_, id) => ({ id: id + 10 })),
        },
        genZDrops: {
          deals: Array.from({ length: 7 }, (_, id) => ({ id: id + 20 })),
        },
      });
      throw new Error('expected validation to fail');
    } catch (error: any) {
      expect(error.details.errors.map((item: any) => item.path)).toEqual([
        ['topPicks', 'deals'],
        ['smartSavingStack', 'deals'],
        ['genZDrops', 'deals'],
      ]);
    }
  });

  it('uses stored relations when Content Manager sends a patch', async () => {
    const { strapi } = strapiWithCurrent({
      topPicks: {
        deals: Array.from({ length: 4 }, (_, id) => ({ id: id + 1 })),
      },
    });

    await expect(
      validateDealOfTheDaySectionLimits(strapi, {
        topPicks: { deals: { connect: [{ id: 5 }], disconnect: [] } },
      })
    ).rejects.toThrow(/Top Picks accepts at most 4/);
  });

  it('skips the database read for unrelated partial updates', async () => {
    const { strapi, findOne } = strapiWithCurrent();

    await validateDealOfTheDaySectionLimits(strapi, { heroTitle: 'New title' });

    expect(findOne).not.toHaveBeenCalled();
  });
});
