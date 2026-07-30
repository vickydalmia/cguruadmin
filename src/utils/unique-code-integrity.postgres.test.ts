import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import uniqueCouponService from '../plugins/unique-coupon/server/src/services/unique-coupon';

const {
  CLAIM_TOKEN_INDEX,
  CODE_GUARD_TRIGGER,
  CODE_LOOKUP_INDEX,
  LINK_GUARD_TRIGGER,
  POOL_LINK_LOOKUP_INDEX,
  UNCLAIMED_CODE_INDEX,
  recountPools,
  reconcileUniqueCodeIntegrity,
} = require('../../database/unique-code-integrity.js');

const databaseUrl = process.env.UNIQUE_CODE_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('unique-code integrity PostgreSQL integration', () => {
  let knex: Knex;

  beforeAll(() => {
    knex = knexFactory({
      client: 'pg',
      connection: databaseUrl,
      // The redemption tests fan out real concurrent claims; a 2-connection
      // pool would serialize them in the client and prove nothing.
      pool: { min: 0, max: 12 },
    });
  });

  beforeEach(async () => {
    await knex.raw(`
      DROP TABLE IF EXISTS "unique_codes_pool_lnk";
      DROP TABLE IF EXISTS "unique_codes";
      DROP TABLE IF EXISTS "unique_coupon_pools";

      CREATE TABLE "unique_coupon_pools" (
        "id" serial PRIMARY KEY,
        "document_id" text,
        "name" text,
        "total_codes" integer NOT NULL DEFAULT 0,
        "used_codes" integer NOT NULL DEFAULT 0,
        "exhausted_at" timestamptz
      );

      CREATE TABLE "unique_codes" (
        "id" serial PRIMARY KEY,
        "document_id" text,
        "code" text NOT NULL,
        "is_used" boolean NOT NULL DEFAULT false,
        "used_at" timestamptz,
        "version" integer NOT NULL DEFAULT 0,
        "claim_token" text,
        "created_at" timestamptz,
        "updated_at" timestamptz,
        "published_at" timestamptz,
        "locale" text
      );

      CREATE TABLE "unique_codes_pool_lnk" (
        "id" serial PRIMARY KEY,
        "unique_code_id" integer NOT NULL
          REFERENCES "unique_codes"("id") ON DELETE CASCADE,
        "unique_coupon_pool_id" integer NOT NULL
          REFERENCES "unique_coupon_pools"("id") ON DELETE CASCADE,
        "unique_code_ord" integer NOT NULL DEFAULT 1,
        UNIQUE ("unique_code_id")
      );
    `);
  });

  afterAll(async () => {
    if (!knex) return;
    await knex.raw(`
      DROP TABLE IF EXISTS "unique_codes_pool_lnk";
      DROP TABLE IF EXISTS "unique_codes";
      DROP TABLE IF EXISTS "unique_coupon_pools";
    `);
    await knex.destroy();
  });

  it('deduplicates through the link table and retains redeemed history', async () => {
    const [pool] = await knex('unique_coupon_pools')
      .insert({})
      .returning(['id']);
    const codes = await knex('unique_codes')
      .insert([
        { code: 'SAVE20', is_used: false },
        {
          code: 'SAVE20',
          is_used: true,
          used_at: '2026-07-20T00:00:00.000Z',
        },
      ])
      .returning(['id']);
    await knex('unique_codes_pool_lnk').insert(
      codes.map((code: { id: number }) => ({
        unique_code_id: code.id,
        unique_coupon_pool_id: pool.id,
        unique_code_ord: 1,
      })),
    );

    await expect(
      knex.transaction((trx) => reconcileUniqueCodeIntegrity(trx)),
    ).resolves.toEqual({
      attempted: true,
      removed: 1,
      guardCreated: true,
    });

    const retained = await knex('unique_codes').select(
      'code',
      'is_used',
      'used_at',
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ code: 'SAVE20', is_used: true });

    const counter = await knex('unique_coupon_pools')
      .where({ id: pool.id })
      .first();
    expect(counter).toMatchObject({ total_codes: 1, used_codes: 1 });

    const triggers = await knex('pg_trigger')
      .whereIn('tgname', [LINK_GUARD_TRIGGER, CODE_GUARD_TRIGGER])
      .where({ tgisinternal: false })
      .pluck('tgname');
    expect(new Set(triggers)).toEqual(
      new Set([LINK_GUARD_TRIGGER, CODE_GUARD_TRIGGER]),
    );
    const indexes = await knex('pg_indexes')
      .whereIn('indexname', [CODE_LOOKUP_INDEX, POOL_LINK_LOOKUP_INDEX])
      .pluck('indexname');
    expect(new Set(indexes)).toEqual(
      new Set([CODE_LOOKUP_INDEX, POOL_LINK_LOOKUP_INDEX]),
    );
  });

  it('rejects a duplicate relation insert and a conflicting code update', async () => {
    const [pool] = await knex('unique_coupon_pools')
      .insert({})
      .returning(['id']);
    const [first] = await knex('unique_codes')
      .insert({ code: 'SAVE20' })
      .returning(['id']);
    await knex('unique_codes_pool_lnk').insert({
      unique_code_id: first.id,
      unique_coupon_pool_id: pool.id,
      unique_code_ord: 1,
    });
    await knex.transaction((trx) => reconcileUniqueCodeIntegrity(trx));

    const [duplicate] = await knex('unique_codes')
      .insert({ code: 'SAVE20' })
      .returning(['id']);
    await expect(
      knex('unique_codes_pool_lnk').insert({
        unique_code_id: duplicate.id,
        unique_coupon_pool_id: pool.id,
        unique_code_ord: 1,
      }),
    ).rejects.toMatchObject({ code: '23505' });

    const [different] = await knex('unique_codes')
      .insert({ code: 'OTHER' })
      .returning(['id']);
    await knex('unique_codes_pool_lnk').insert({
      unique_code_id: different.id,
      unique_coupon_pool_id: pool.id,
      unique_code_ord: 1,
    });
    await expect(
      knex('unique_codes')
        .where({ id: different.id })
        .update({ code: 'SAVE20' }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('serializes concurrent equal pool/code links before checking uniqueness', async () => {
    const [pool] = await knex('unique_coupon_pools')
      .insert({})
      .returning(['id']);
    const codes = await knex('unique_codes')
      .insert([{ code: 'RACE' }, { code: 'RACE' }])
      .returning(['id']);
    await knex.transaction((trx) => reconcileUniqueCodeIntegrity(trx));

    const first = await knex.transaction();
    const second = await knex.transaction();
    try {
      await first('unique_codes_pool_lnk').insert({
        unique_code_id: codes[0].id,
        unique_coupon_pool_id: pool.id,
        unique_code_ord: 1,
      });

      const competingInsert = Promise.resolve(
        second('unique_codes_pool_lnk').insert({
          unique_code_id: codes[1].id,
          unique_coupon_pool_id: pool.id,
          unique_code_ord: 1,
        }),
      );
      const earlyState = await Promise.race([
        competingInsert.then(
          () => 'accepted',
          () => 'rejected',
        ),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), 100),
        ),
      ]);
      expect(earlyState).toBe('blocked');

      await first.commit();
      await expect(competingInsert).rejects.toMatchObject({ code: '23505' });
      await second.rollback();
    } finally {
      if (!first.isCompleted()) await first.rollback();
      if (!second.isCompleted()) await second.rollback();
    }
  });

  it('imports, redeems, and counts through the existing Strapi relation', async () => {
    await knex('unique_coupon_pools').insert({
      document_id: 'pool-doc',
      name: 'Production Pool',
    });
    await knex.transaction((trx) => reconcileUniqueCodeIntegrity(trx));

    const strapi = {
      db: { connection: knex },
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    } as any;
    const service = uniqueCouponService({ strapi });

    await expect(
      service.importCodes('pool-doc', ['FIRST', 'SECOND', 'FIRST']),
    ).resolves.toEqual({ imported: 2, skipped: 1, total: 3 });

    await expect(service.getPoolStats('pool-doc')).resolves.toMatchObject({
      totalCodes: 2,
      usedCodes: 0,
      availableCodes: 2,
    });

    await expect(service.redeemCode('pool-doc')).resolves.toEqual({
      success: true,
      code: 'FIRST',
    });

    await expect(service.getPoolStats('pool-doc')).resolves.toMatchObject({
      totalCodes: 2,
      usedCodes: 1,
      availableCodes: 1,
    });

    await expect(knex('unique_codes_pool_lnk').count({ count: '*' }).first())
      .resolves.toMatchObject({ count: '2' });
    const poolIdColumn = await knex('information_schema.columns')
      .where({
        table_schema: 'public',
        table_name: 'unique_codes',
        column_name: 'pool_id',
      })
      .first();
    expect(poolIdColumn).toBeUndefined();
  });

  describe('concurrent redemption', () => {
    const CODE_COUNT = 24;

    async function seedPool(codeCount = CODE_COUNT) {
      await knex('unique_coupon_pools').insert({
        document_id: 'pool-doc',
        name: 'Concurrency Pool',
      });
      await knex.transaction((trx) => reconcileUniqueCodeIntegrity(trx));

      const strapi = {
        db: { connection: knex },
        log: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      } as any;
      const service = uniqueCouponService({ strapi });
      await service.importCodes(
        'pool-doc',
        Array.from({ length: codeCount }, (_, index) => `CODE-${index}`),
      );
      return service;
    }

    it('never hands the same code to two simultaneous claimers', async () => {
      // The whole point of the feature. Every claim runs at once against one
      // pool; correctness comes from the conditional UPDATE, not from queuing.
      const service = await seedPool();

      const results = await Promise.all(
        Array.from({ length: CODE_COUNT }, () => service.redeemCode('pool-doc')),
      );

      const codes = results
        .filter((result): result is { success: true; code: string } => result.success)
        .map((result) => result.code);
      expect(codes).toHaveLength(CODE_COUNT);
      expect(new Set(codes).size).toBe(CODE_COUNT);

      const used = await knex('unique_codes').where({ is_used: true }).count({
        count: '*',
      }).first();
      expect(used).toMatchObject({ count: String(CODE_COUNT) });
    });

    it('reports exhaustion exactly once past the last code, never early', async () => {
      const service = await seedPool();

      const results = await Promise.all(
        Array.from({ length: CODE_COUNT + 3 }, () =>
          service.redeemCode('pool-doc'),
        ),
      );

      const succeeded = results.filter((result) => result.success);
      const exhausted = results.filter(
        (result) => !result.success && result.error === 'NO_CODES_AVAILABLE',
      );
      expect(succeeded).toHaveLength(CODE_COUNT);
      expect(exhausted).toHaveLength(3);
      // A code locked by a concurrent claimer must never be mistaken for an
      // empty pool.
      expect(results.filter((result) => !result.success)).toHaveLength(3);
    });

    it('burns one code per activation no matter how often it is retried', async () => {
      const service = await seedPool();
      const activationId = 'b9d2c1a4e5f64738a1b2c3d4e5f60718';

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.redeemCode('pool-doc', { activationId }),
        ),
      );

      const codes = new Set(
        results
          .filter((result): result is { success: true; code: string } => result.success)
          .map((result) => result.code),
      );
      expect(results.every((result) => result.success)).toBe(true);
      expect(codes.size).toBe(1);

      const used = await knex('unique_codes').where({ is_used: true }).count({
        count: '*',
      }).first();
      expect(used).toMatchObject({ count: '1' });
    });

    it('replays the final code to concurrent twins of the claiming activation', async () => {
      // Racing on the LAST code: one twin claims it, the others find the pool
      // drained. The drained edge must recheck replay() — otherwise the
      // losers report NO_CODES_AVAILABLE for an activation that holds a code.
      const service = await seedPool(1);
      const activationId = 'c0ffeec0ffeec0ffeec0ffeec0ffee11';

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          service.redeemCode('pool-doc', { activationId }),
        ),
      );

      expect(results.every((result) => result.success)).toBe(true);
      const codes = new Set(
        results.map((result) => (result as { code?: string }).code),
      );
      expect(codes.size).toBe(1);

      const used = await knex('unique_codes').where({ is_used: true }).count({
        count: '*',
      }).first();
      expect(used).toMatchObject({ count: '1' });
    });

    it('gives a different activation a different code', async () => {
      const service = await seedPool();

      const first = await service.redeemCode('pool-doc', {
        activationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      const second = await service.redeemCode('pool-doc', {
        activationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      // A reload replays; a new click draws.
      const replayed = await service.redeemCode('pool-doc', {
        activationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });

      expect(first).toMatchObject({ success: true });
      expect(second).toMatchObject({ success: true });
      expect((first as any).code).not.toBe((second as any).code);
      expect((replayed as any).code).toBe((first as any).code);
    });

    it('marks the pool exhausted when the last code goes out', async () => {
      const service = await seedPool(1);

      await expect(service.redeemCode('pool-doc')).resolves.toMatchObject({
        success: true,
      });
      // Not yet: the pool is empty but nothing has asked for a code and been
      // refused, so the drained edge has not been reached.
      await expect(
        knex('unique_coupon_pools').where({ document_id: 'pool-doc' }).first(),
      ).resolves.toMatchObject({ exhausted_at: null });

      await expect(service.redeemCode('pool-doc')).resolves.toMatchObject({
        error: 'NO_CODES_AVAILABLE',
      });
      const drained = await knex('unique_coupon_pools')
        .where({ document_id: 'pool-doc' })
        .first();
      expect(drained.exhausted_at).toBeInstanceOf(Date);

      // Restocking clears it, so the scheduler can bring the offers back.
      await service.importCodes('pool-doc', ['REFILL']);
      await expect(
        knex('unique_coupon_pools').where({ document_id: 'pool-doc' }).first(),
      ).resolves.toMatchObject({ exhausted_at: null });
    });

    it('recounts drained pools that never saw another click', async () => {
      // Redemption stamps the drained edge, but a pool whose last code went out
      // and then saw no traffic would otherwise never be noticed.
      const service = await seedPool(2);
      await service.redeemCode('pool-doc');
      await service.redeemCode('pool-doc');

      await expect(
        knex('unique_coupon_pools').where({ document_id: 'pool-doc' }).first(),
      ).resolves.toMatchObject({ exhausted_at: null });

      await recountPools(knex);

      const pool = await knex('unique_coupon_pools')
        .where({ document_id: 'pool-doc' })
        .first();
      expect(pool.exhausted_at).toBeInstanceOf(Date);
      // The counters redemption no longer maintains inline are reconciled here.
      expect(pool).toMatchObject({ total_codes: 2, used_codes: 2 });
    });

    it('leaves a pool that has never held a code alone', async () => {
      // An editor mid-setup must not have their offers expired out from under
      // them before the first import lands.
      await knex('unique_coupon_pools').insert({
        document_id: 'empty-pool',
        name: 'Empty',
      });
      await knex.transaction((trx) => reconcileUniqueCodeIntegrity(trx));

      await recountPools(knex);

      await expect(
        knex('unique_coupon_pools').where({ document_id: 'empty-pool' }).first(),
      ).resolves.toMatchObject({ exhausted_at: null, total_codes: 0 });
    });

    it('a restock committing mid-recount is not overwritten', async () => {
      // The recount locks the pool rows before aggregating, so an import
      // holding the pool row lock finishes first and its codes are counted —
      // the recount can no longer write back a pre-restock snapshot and
      // resurrect stale counters or a cleared exhausted_at.
      const service = await seedPool(1);
      await service.redeemCode('pool-doc');
      await service.redeemCode('pool-doc'); // drained edge stamps exhausted_at

      // Hold the pool row lock the way importCodes does, start the recount,
      // then finish the restock while the recount waits on the lock.
      const trx = await knex.transaction();
      const pool = await trx('unique_coupon_pools')
        .where({ document_id: 'pool-doc' })
        .forUpdate()
        .first();
      const recount = recountPools(knex);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const [codeRow] = await trx('unique_codes').insert(
        { document_id: 'refill-doc', code: 'REFILL', is_used: false },
        ['id'],
      );
      await trx('unique_codes_pool_lnk').insert({
        unique_code_id: codeRow.id,
        unique_coupon_pool_id: pool.id,
      });
      await trx('unique_coupon_pools')
        .where({ id: pool.id })
        .update({ total_codes: 2, exhausted_at: null });
      await trx.commit();
      await recount;

      await expect(
        knex('unique_coupon_pools').where({ document_id: 'pool-doc' }).first(),
      ).resolves.toMatchObject({
        total_codes: 2,
        used_codes: 1,
        exhausted_at: null,
      });
    });

    it('recounts inside a caller transaction via savepoint', async () => {
      // Bootstrap calls recountPools with an open transaction; the internal
      // knex.transaction must nest as a savepoint, not deadlock or escape.
      const service = await seedPool(2);
      await service.redeemCode('pool-doc');

      await knex.transaction((trx) => recountPools(trx));

      await expect(
        knex('unique_coupon_pools').where({ document_id: 'pool-doc' }).first(),
      ).resolves.toMatchObject({ total_codes: 2, used_codes: 1 });
    });

    it('installs the partial indexes the claim depends on', async () => {
      await seedPool(1);

      const indexes = await knex('pg_indexes')
        .whereIn('indexname', [UNCLAIMED_CODE_INDEX, CLAIM_TOKEN_INDEX])
        .select('indexname', 'indexdef');
      expect(new Set(indexes.map((row: any) => row.indexname))).toEqual(
        new Set([UNCLAIMED_CODE_INDEX, CLAIM_TOKEN_INDEX]),
      );
      const unclaimed = indexes.find(
        (row: any) => row.indexname === UNCLAIMED_CODE_INDEX,
      );
      expect(unclaimed.indexdef).toContain('WHERE (is_used = false)');
      const claimToken = indexes.find(
        (row: any) => row.indexname === CLAIM_TOKEN_INDEX,
      );
      expect(claimToken.indexdef).toContain('UNIQUE');
    });
  });
});
