import { describe, expect, it, vi } from 'vitest';

const migration = require('../../database/migrations/2026.07.31T03.00.00.reconcile-legacy-isr-outbox-optional-paths.js');

describe('legacy ISR optional-path reconciliation', () => {
  it.each([
    {
      reason: 'api::store.store update',
      path: '/museum-of-ice-cream-singapore-deals/',
    },
    {
      reason: 'api::brand.brand update',
      path: '/ugreen-deals/',
    },
    {
      reason: 'api::category.category publish',
      path: '/consumer-electronics-deals/',
    },
    {
      reason: 'api::deal.deal update',
      path: '/amazon-deals/',
    },
    {
      reason: 'api::deal.deal delete',
      path: '/deal/4037/',
    },
    {
      reason: 'api::coupon.coupon delete',
      path: '/coupon/123/',
    },
  ])('classifies an expected absent route for $reason', ({ reason, path }) => {
    const payload = {
      paths: ['/', '/sitemap_index.xml', path],
      scopes: ['sitemap', 'routes'],
    };

    expect(
      migration.reconcileLegacyPayload({
        reason,
        payload,
        last_error: `gateway skipped 1 path(s): ${path}`,
      }),
    ).toEqual({ ...payload, optionalPaths: [path] });
  });

  it.each([
    {
      reason: 'api::store.store update',
      path: '/made-up-route/',
      error: 'gateway skipped 1 path(s): /made-up-route/',
    },
    {
      reason: 'api::coupon.coupon update',
      path: '/deal/4037/',
      error: 'gateway skipped 1 path(s): /deal/4037/',
    },
    {
      reason: 'api::store.store update',
      path: '/amazon-deals/',
      error: 'gateway skipped 2 path(s): /amazon-deals/, /other/',
    },
  ])('does not hide an unrelated skipped route', ({ reason, path, error }) => {
    expect(
      migration.reconcileLegacyPayload({
        reason,
        payload: { paths: ['/', path] },
        last_error: error,
      }),
    ).toBeNull();
  });

  it('requires the skipped path to be part of the original command', () => {
    expect(
      migration.reconcileLegacyPayload({
        reason: 'api::store.store update',
        payload: { paths: ['/'] },
        last_error: 'gateway skipped 1 path(s): /amazon-deals/',
      }),
    ).toBeNull();
  });

  it('preserves existing optional paths and is idempotent', () => {
    const row = {
      reason: 'api::store.store update',
      payload: {
        paths: ['/', '/old-deals/', '/new-deals/'],
        optionalPaths: ['/old-deals/'],
      },
      last_error: 'gateway skipped 1 path(s): /new-deals/',
    };
    const repaired = migration.reconcileLegacyPayload(row);
    expect(repaired.optionalPaths).toEqual(['/old-deals/', '/new-deals/']);
    expect(
      migration.reconcileLegacyPayload({ ...row, payload: repaired }),
    ).toBeNull();
  });

  it('updates only undelivered matching rows without changing delivery state', async () => {
    const rows = [
      {
        id: 1,
        status: 'pending',
        reason: 'api::bank.bank update',
        payload: {
          paths: ['/', '/american-express-deals/'],
          scopes: ['routes'],
        },
        last_error:
          'gateway skipped 1 path(s): /american-express-deals/',
      },
      {
        id: 2,
        status: 'delivered',
        reason: 'api::bank.bank update',
        payload: { paths: ['/', '/delivered-deals/'] },
        last_error: 'gateway skipped 1 path(s): /delivered-deals/',
      },
    ];

    const knex: any = (table: string) => {
      expect(table).toBe('isr_outbox');
      const predicates: Array<(row: any) => boolean> = [];
      const query: any = {
        select() {
          return query;
        },
        whereIn(column: string, values: unknown[]) {
          predicates.push((row) => values.includes(row[column]));
          return query;
        },
        whereNotNull(column: string) {
          predicates.push((row) => row[column] != null);
          return query;
        },
        where(
          columnOrValues: string | Record<string, unknown>,
          operator?: string,
          value?: string,
        ) {
          if (typeof columnOrValues === 'object') {
            predicates.push((row) =>
              Object.entries(columnOrValues).every(
                ([column, expected]) => row[column] === expected,
              ),
            );
          } else if (operator === 'like') {
            const prefix = String(value).replace(/%$/, '');
            predicates.push((row) =>
              String(row[columnOrValues]).startsWith(prefix),
            );
          }
          return query;
        },
        async update(values: Record<string, unknown>) {
          let count = 0;
          for (const row of rows) {
            if (!predicates.every((predicate) => predicate(row))) continue;
            Object.assign(row, values);
            count += 1;
          }
          return count;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(
            rows.filter((row) => predicates.every((predicate) => predicate(row))),
          ).then(resolve);
        },
      };
      return query;
    };
    knex.schema = { hasTable: vi.fn(async () => true) };

    await migration.up(knex);

    expect(rows[0]?.status).toBe('pending');
    expect(JSON.parse(String(rows[0]?.payload))).toMatchObject({
      optionalPaths: ['/american-express-deals/'],
    });
    expect(rows[1]?.payload).toEqual({
      paths: ['/', '/delivered-deals/'],
    });
  });
});
