import { describe, expect, it, vi } from 'vitest';
import {
  resultingRelationCount,
  validateDealOfTheDaySectionLimits,
} from './deal-of-the-day-validation';

function strapiWithCurrent(
  current: any = {},
  qualifyingDealIds: ReadonlySet<string | number> | null = null
) {
  const findOne = vi.fn().mockResolvedValue(current);
  const findMany = vi.fn(({ where }: any) => {
    const clauses = where?.$or ?? [];
    const ids = clauses.flatMap((clause: any) => clause.id?.$in ?? []);
    const documentIds = clauses.flatMap(
      (clause: any) => clause.documentId?.$in ?? []
    );
    return [...ids, ...documentIds].map((key) => ({
      id: typeof key === 'number' ? key : undefined,
      documentId: typeof key === 'string' ? key : undefined,
      code:
        qualifyingDealIds == null || qualifyingDealIds.has(key) ? 'SAVE20' : null,
      cashbackText:
        qualifyingDealIds == null || qualifyingDealIds.has(key) ? '15%' : null,
      bankOfferText:
        qualifyingDealIds == null || qualifyingDealIds.has(key) ? '₹200' : null,
    }));
  });
  return {
    strapi: {
      db: {
        query: vi.fn((uid: string) =>
          uid === 'api::deal.deal' ? { findMany } : { findOne }
        ),
      },
    } as any,
    findOne,
    findMany,
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

  it('accepts fixed authoring caps and an unlimited Smart Stack', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateDealOfTheDaySectionLimits(strapi, {
        topPicks: { deals: Array.from({ length: 4 }, (_, id) => ({ id })) },
        smartSavingStack: {
          deals: Array.from({ length: 20 }, (_, id) => ({ id: id + 10 })),
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
        genZDrops: {
          deals: Array.from({ length: 7 }, (_, id) => ({ id: id + 20 })),
        },
      });
      throw new Error('expected validation to fail');
    } catch (error: any) {
      expect(error.details.errors.map((item: any) => item.path)).toEqual([
        ['topPicks', 'deals'],
        ['genZDrops', 'deals'],
      ]);
    }
  });

  it('requires at least three Smart Stack Deals when enabled', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateDealOfTheDaySectionLimits(strapi, {
        smartSavingStack: {
          enabled: true,
          deals: [{ id: 1 }, { id: 2 }],
        },
      })
    ).rejects.toThrow(/requires at least 3 eligible Deals/);
  });

  it('counts only Smart Stack Deals with code and both required benefit texts', async () => {
    const { strapi } = strapiWithCurrent({}, new Set([1, 2]));

    await expect(
      validateDealOfTheDaySectionLimits(strapi, {
        smartSavingStack: {
          enabled: true,
          deals: [{ id: 1 }, { id: 2 }, { id: 3 }],
        },
      })
    ).rejects.toThrow(/Add 1 more eligible Deal/);
  });

  it('allows fewer than three Smart Stack Deals when disabled', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateDealOfTheDaySectionLimits(strapi, {
        smartSavingStack: {
          enabled: false,
          deals: [{ id: 1 }],
        },
      })
    ).resolves.toBeUndefined();
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
