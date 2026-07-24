import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import uniqueCouponService from '../plugins/unique-coupon/server/src/services/unique-coupon';

const {
  CODE_GUARD_TRIGGER,
  LINK_GUARD_TRIGGER,
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
      pool: { min: 0, max: 2 },
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
        "used_codes" integer NOT NULL DEFAULT 0
      );

      CREATE TABLE "unique_codes" (
        "id" serial PRIMARY KEY,
        "document_id" text,
        "code" text NOT NULL,
        "is_used" boolean NOT NULL DEFAULT false,
        "used_at" timestamptz,
        "version" integer NOT NULL DEFAULT 0,
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
});
