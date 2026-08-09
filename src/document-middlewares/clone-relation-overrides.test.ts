import { describe, expect, it, vi } from 'vitest';
import { merge } from 'lodash/fp';

import {
  assertCloneRelationFieldCoverage,
  collectCloneRelationProblems,
  prepareCloneRelationOverrides,
} from './clone-relation-overrides';

const OFFER_UID = 'api::coupon.coupon';

function harness(input: {
  contentUid?: string;
  current: Record<string, unknown>;
  targets: Record<string, any[]>;
}) {
  const contentUid = input.contentUid ?? OFFER_UID;
  const query = vi.fn((uid: string) => {
    if (uid === contentUid) {
      return { findOne: vi.fn().mockResolvedValue(input.current) };
    }
    return {
      findMany: vi.fn().mockResolvedValue(input.targets[uid] ?? []),
    };
  });
  const forUpdate = vi.fn(async () => []);
  const where = vi.fn(() => ({ forUpdate }));
  const select = vi.fn(() => ({ where }));
  const trx = vi.fn(() => ({ select }));
  const strapi = {
    db: {
      query,
      metadata: {
        get: vi.fn(() => ({
          tableName: 'content_rows',
          attributes: {
            id: { columnName: 'id' },
            documentId: { columnName: 'document_id' },
          },
        })),
      },
    },
  } as any;
  return { strapi, trx, select, where, forUpdate };
}

describe('clone relation overrides', () => {
  it('converts connect/disconnect into an exact padded id array', async () => {
    const original = {
      connect: [{ documentId: 'brand-2' }],
      disconnect: [
        { documentId: 'brand-1' },
        { documentId: 'brand-3' },
      ],
    };
    const context = {
      uid: OFFER_UID,
      action: 'clone',
      params: {
        documentId: 'offer-source',
        data: { title: 'Copy', brands: original },
      },
    };
    const { strapi, trx, select, where, forUpdate } = harness({
      current: {
        id: 10,
        documentId: 'offer-source',
        brands: [
          { id: 1, documentId: 'brand-1' },
          { id: 3, documentId: 'brand-3' },
        ],
      },
      targets: {
        'api::brand.brand': [
          { id: 1, documentId: 'brand-1' },
          { id: 2, documentId: 'brand-2' },
          { id: 3, documentId: 'brand-3' },
        ],
      },
    });

    const prepared = await prepareCloneRelationOverrides(strapi, context, trx);

    // The duplicate overwrites the source array's second index during lodash
    // merge; Strapi deduplicates ids before attaching the relation.
    expect(context.params.data).toEqual({ title: 'Copy', brands: [2, 2] });
    const merged = merge(
      {
        brands: [
          { id: 1, documentId: 'brand-1' },
          { id: 3, documentId: 'brand-3' },
        ],
      },
      context.params.data,
    );
    expect(merged.brands).toEqual([2, 2]);
    expect([...new Set(merged.brands)]).toEqual([2]);
    expect(trx).toHaveBeenCalledWith('content_rows');
    expect(select).toHaveBeenCalledWith('id');
    expect(where).toHaveBeenCalledWith('document_id', 'offer-source');
    expect(forUpdate).toHaveBeenCalledTimes(1);

    prepared.restore();
    expect(context.params.data.brands).toBe(original);
  });

  it('makes set-empty clear inverse offer relations on a clone', async () => {
    const context = {
      uid: 'api::brand.brand',
      action: 'clone',
      params: {
        documentId: 'brand-source',
        data: {
          coupons: { set: [] },
          deals: { set: [] },
        },
      },
    };
    const { strapi, trx } = harness({
      contentUid: 'api::brand.brand',
      current: {
        id: 10,
        documentId: 'brand-source',
        coupons: [{ id: 11, documentId: 'coupon-1' }],
        deals: [{ id: 22, documentId: 'deal-1' }],
      },
      targets: {},
    });

    await prepareCloneRelationOverrides(strapi, context, trx);

    expect(context.params.data).toEqual({
      coupons: null,
      deals: null,
    });
    expect(
      merge(
        {
          coupons: [{ id: 11 }],
          deals: [{ id: 22 }],
        },
        context.params.data,
      ),
    ).toEqual({ coupons: null, deals: null });
  });

  it('replaces a shorter direct array instead of retaining the source tail', async () => {
    const context = {
      uid: OFFER_UID,
      action: 'clone',
      params: {
        documentId: 'offer-source',
        data: { categories: [{ documentId: 'category-2' }] },
      },
    };
    const { strapi, trx } = harness({
      current: {
        id: 10,
        documentId: 'offer-source',
        categories: [
          { id: 31, documentId: 'category-1' },
          { id: 32, documentId: 'category-2' },
          { id: 33, documentId: 'category-3' },
        ],
      },
      targets: {
        'api::category.category': [
          { id: 32, documentId: 'category-2' },
        ],
      },
    });

    await prepareCloneRelationOverrides(strapi, context, trx);

    expect(context.params.data.categories).toEqual([32, 32, 32]);
  });

  it('fails before mutating the payload when a selected relation disappeared', async () => {
    const original = [{ documentId: 'bank-gone' }];
    const context = {
      uid: OFFER_UID,
      action: 'clone',
      params: {
        documentId: 'offer-source',
        data: { banks: original },
      },
    };
    const { strapi, trx } = harness({
      current: { id: 10, documentId: 'offer-source', banks: [] },
      targets: { 'api::bank.bank': [] },
    });

    await expect(
      prepareCloneRelationOverrides(strapi, context, trx),
    ).rejects.toThrow(/no longer exist/);
    expect(context.params.data.banks).toBe(original);
  });

  it('gives documentId strict precedence over a stale numeric id', async () => {
    // Strapi core discards the raw id whenever documentId is present
    // (data-ids.js); matching by "any shared key" would let the stale id 42
    // win and silently attach the wrong brand.
    const context = {
      uid: OFFER_UID,
      action: 'clone',
      params: {
        documentId: 'offer-source',
        data: { brands: { set: [{ id: 42, documentId: 'brand-live' }] } },
      },
    };
    const { strapi, trx } = harness({
      current: { id: 10, documentId: 'offer-source', brands: [] },
      targets: {
        'api::brand.brand': [
          { id: 42, documentId: 'brand-other' },
          { id: 7, documentId: 'brand-live' },
        ],
      },
    });

    await prepareCloneRelationOverrides(strapi, context, trx);

    expect(context.params.data.brands).toEqual([7]);
  });

  it('resolves a bare numeric-string entry as an entity id fallback', async () => {
    // This repo's convention reads bare strings as documentIds, but Strapi
    // core reads numeric strings as entity ids — the fallback accepts either.
    const context = {
      uid: OFFER_UID,
      action: 'clone',
      params: {
        documentId: 'offer-source',
        data: { categories: ['5'] },
      },
    };
    const { strapi, trx } = harness({
      current: { id: 10, documentId: 'offer-source', categories: [] },
      targets: {
        'api::category.category': [{ id: 5, documentId: 'category-x' }],
      },
    });

    await prepareCloneRelationOverrides(strapi, context, trx);

    expect(context.params.data.categories).toEqual([5]);
  });

  it('verify passes on a faithful clone and rolls back a drifted one', async () => {
    const sourceRow = {
      id: 10,
      documentId: 'offer-source',
      brands: [{ id: 1, documentId: 'brand-1' }],
    };
    let cloneBrands: any[] = [{ id: 2 }];
    const query = vi.fn((uid: string) => {
      if (uid === OFFER_UID) {
        return {
          findOne: vi.fn(async ({ where }: any) =>
            where?.documentId === 'offer-source'
              ? sourceRow
              : { id: 20, brands: cloneBrands },
          ),
        };
      }
      return {
        findMany: vi.fn(async () => [{ id: 2, documentId: 'brand-2' }]),
      };
    });
    const forUpdate = vi.fn(async () => []);
    const where = vi.fn(() => ({ forUpdate }));
    const select = vi.fn(() => ({ where }));
    const trx = vi.fn(() => ({ select }));
    const strapi = {
      db: {
        query,
        metadata: {
          get: vi.fn(() => ({
            tableName: 'content_rows',
            attributes: {
              id: { columnName: 'id' },
              documentId: { columnName: 'document_id' },
            },
          })),
        },
      },
    } as any;
    const context = {
      uid: OFFER_UID,
      action: 'clone',
      params: {
        documentId: 'offer-source',
        data: { brands: { set: [{ documentId: 'brand-2' }] } },
      },
    };

    const prepared = await prepareCloneRelationOverrides(strapi, context, trx);

    // The clone holds exactly the resolved set — silence.
    await expect(
      prepared.verify({ documentId: 'offer-clone' }),
    ).resolves.toBeUndefined();

    // The merge misbehaved (a source relation survived): loud rollback.
    cloneBrands = [{ id: 2 }, { id: 1 }];
    await expect(
      prepared.verify({ documentId: 'offer-clone' }),
    ).rejects.toThrow(/Rolling the clone back/);
  });
});

describe('collectCloneRelationProblems', () => {
  const strapiWithBrands = (rows: any[]) =>
    ({
      db: {
        query: vi.fn(() => ({ findMany: vi.fn(async () => rows) })),
      },
    }) as any;

  it('reports a vanished named relation as an aggregatable problem', async () => {
    const problems = await collectCloneRelationProblems(
      strapiWithBrands([]),
      OFFER_UID,
      'clone',
      { brands: { connect: [{ documentId: 'brand-gone' }] } },
    );
    expect(problems).toEqual([
      { path: ['brands'], message: expect.stringContaining('no longer exist') },
    ]);
  });

  it('stays silent when every named relation resolves', async () => {
    const problems = await collectCloneRelationProblems(
      strapiWithBrands([{ id: 2, documentId: 'brand-2' }]),
      OFFER_UID,
      'clone',
      { brands: { set: [{ documentId: 'brand-2' }] } },
    );
    expect(problems).toEqual([]);
  });

  it('ignores disconnect-only payloads (absence cannot dangle)', async () => {
    const strapi = strapiWithBrands([]);
    const problems = await collectCloneRelationProblems(
      strapi,
      OFFER_UID,
      'clone',
      { brands: { disconnect: [{ documentId: 'brand-1' }] } },
    );
    expect(problems).toEqual([]);
    expect(strapi.db.query).not.toHaveBeenCalled();
  });

  it('is a no-op outside clone', async () => {
    const strapi = strapiWithBrands([]);
    await expect(
      collectCloneRelationProblems(strapi, OFFER_UID, 'update', {
        brands: [{ documentId: 'brand-gone' }],
      }),
    ).resolves.toEqual([]);
    expect(strapi.db.query).not.toHaveBeenCalled();
  });
});

describe('assertCloneRelationFieldCoverage', () => {
  const manyToMany = (target: string) => ({
    type: 'relation',
    relation: 'manyToMany',
    target,
  });
  const schemaFixture = () => ({
    'api::coupon.coupon': {
      attributes: {
        title: { type: 'string' },
        stores: manyToMany('api::store.store'),
        brands: manyToMany('api::brand.brand'),
        categories: manyToMany('api::category.category'),
        banks: manyToMany('api::bank.bank'),
        // manyToOne relations are outside the broken-merge shape and must
        // not trip the assertion.
        logoStore: {
          type: 'relation',
          relation: 'manyToOne',
          target: 'api::store.store',
        },
      },
    },
    'api::deal.deal': {
      attributes: {
        stores: manyToMany('api::store.store'),
        brands: manyToMany('api::brand.brand'),
        categories: manyToMany('api::category.category'),
        banks: manyToMany('api::bank.bank'),
      },
    },
    'api::store.store': {
      attributes: {
        coupons: manyToMany('api::coupon.coupon'),
        deals: manyToMany('api::deal.deal'),
        topPickCoupons: manyToMany('api::coupon.coupon'),
        orderedCoupons: manyToMany('api::coupon.coupon'),
      },
    },
    'api::brand.brand': {
      attributes: {
        coupons: manyToMany('api::coupon.coupon'),
        deals: manyToMany('api::deal.deal'),
        topPickCoupons: manyToMany('api::coupon.coupon'),
        orderedCoupons: manyToMany('api::coupon.coupon'),
      },
    },
  });

  it('accepts the current schemas (covered + documented exclusions)', () => {
    expect(() =>
      assertCloneRelationFieldCoverage({ contentTypes: schemaFixture() } as any),
    ).not.toThrow();
  });

  it('fails startup when a schema gains an uncovered relation field', () => {
    const contentTypes = schemaFixture();
    (contentTypes['api::store.store'].attributes as any).featuredCoupons =
      manyToMany('api::coupon.coupon');
    expect(() =>
      assertCloneRelationFieldCoverage({ contentTypes } as any),
    ).toThrow(/featuredCoupons/);
  });
});
