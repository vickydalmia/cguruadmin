import { describe, expect, it, vi } from 'vitest';
import {
  resultingRelationCount,
  validateDealOfTheDaySectionLimits,
} from './deal-of-the-day-validation';

function strapiWithCurrent(
  current: any = {},
  qualifyingBenefitDealIds: ReadonlySet<string | number> | null = null
) {
  const findOne = vi.fn().mockResolvedValue(current);
  const findMany = vi.fn(({ where }: any) => {
    // The real query pins the content locale around the relation match:
    // { $and: [{ locale }, { $or: [...] }] }.
    const relationWhere =
      where?.$and?.find((clause: any) => clause?.$or) ?? where;
    const clauses = relationWhere?.$or ?? [];
    const ids = clauses.flatMap((clause: any) => clause.id?.$in ?? []);
    const documentIds = clauses.flatMap(
      (clause: any) => clause.documentId?.$in ?? []
    );
    return [...ids, ...documentIds].map((key) => ({
      id: typeof key === 'number' ? key : undefined,
      documentId: typeof key === 'string' ? key : undefined,
      // Deliberately no code: Smart Stack eligibility is based only on the two
      // benefit texts.
      code: null,
      cashbackText:
        qualifyingBenefitDealIds == null ||
        qualifyingBenefitDealIds.has(key)
          ? '15%'
          : null,
      bankOfferText:
        qualifyingBenefitDealIds == null ||
        qualifyingBenefitDealIds.has(key)
          ? '₹200'
          : null,
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
        allDeals: {
          deals: Array.from({ length: 50 }, (_, id) => ({ id: id + 30 })),
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
        allDeals: {
          deals: Array.from({ length: 51 }, (_, id) => ({ id: id + 30 })),
        },
      });
      throw new Error('expected validation to fail');
    } catch (error: any) {
      expect(error.details.errors.map((item: any) => item.path)).toEqual([
        ['topPicks', 'deals'],
        ['genZDrops', 'deals'],
        ['allDeals', 'deals'],
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

  it('counts no-code Smart Stack Deals when both benefit texts exist', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateDealOfTheDaySectionLimits(strapi, {
        smartSavingStack: {
          enabled: true,
          deals: [{ id: 1 }, { id: 2 }, { id: 3 }],
        },
      })
    ).resolves.toBeUndefined();
  });

  it('counts only Smart Stack Deals with both required benefit texts', async () => {
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

  it('accepts telegram items with a valid or empty link override', async () => {
    const { strapi, findOne } = strapiWithCurrent();

    await validateDealOfTheDaySectionLimits(strapi, {
      telegramDeals: {
        items: [
          { deal: { id: 1 }, linkOverride: 'https://t.me/couponzguru/42' },
          // Empty deliberately falls back to the deal's affiliate link.
          { deal: { id: 2 }, linkOverride: '' },
          { deal: { id: 3 }, linkOverride: null },
          { deal: { id: 4 } },
        ],
      },
    });

    // Component lists arrive complete, so no stored row is needed.
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects a malformed telegram link override with an indexed path', async () => {
    const { strapi } = strapiWithCurrent();

    for (const bad of ['t.me/couponzguru', 'javascript:alert(1)', 'https://t.me/a b']) {
      await expect(
        validateDealOfTheDaySectionLimits(strapi, {
          telegramDeals: { items: [{ deal: { id: 1 }, linkOverride: bad }] },
        })
      ).rejects.toThrow(/Telegram link must be a complete http\(s\) URL/);
    }

    await validateDealOfTheDaySectionLimits(strapi, {
      telegramDeals: {
        items: [
          { deal: { id: 1 }, linkOverride: 'https://t.me/ok' },
          { deal: { id: 2 }, linkOverride: 'not-a-url' },
        ],
      },
    }).catch((error: any) => {
      expect(error.details.errors[0].path).toEqual([
        'telegramDeals',
        'items',
        '1',
        'linkOverride',
      ]);
    });
  });

  it('rejects more than six telegram items', async () => {
    const { strapi } = strapiWithCurrent();

    await expect(
      validateDealOfTheDaySectionLimits(strapi, {
        telegramDeals: {
          items: Array.from({ length: 7 }, (_, id) => ({ deal: { id: id + 1 } })),
        },
      })
    ).rejects.toThrow(/Telegram Exclusive accepts at most 6 Deals/);
  });

  it('skips the database read for unrelated partial updates', async () => {
    const { strapi, findOne } = strapiWithCurrent();

    await validateDealOfTheDaySectionLimits(strapi, { heroTitle: 'New title' });

    expect(findOne).not.toHaveBeenCalled();
  });
});
