import { describe, expect, it, vi } from 'vitest';

import {
  DEAL_DISCOUNT_PREFIXES,
  formatDealDiscount,
  parseLegacyDealDiscount,
} from './deal-discount';

const migration = require('../../database/migrations/2026.07.31T01.00.00.standardize-deal-discounts.js');

describe('Deal discount formatting', () => {
  it('formats discount prefixes with the shared amount syntax', () => {
    for (const { value, label } of DEAL_DISCOUNT_PREFIXES.filter(
      ({ value }) => value !== 'under' && value !== 'below',
    )) {
      expect(formatDealDiscount('10 %', value)).toBe(`${label} 10% OFF`);
    }
    expect(formatDealDiscount('Rs. 2,000', 'flat')).toBe('Flat ₹2000 OFF');
    expect(formatDealDiscount('$ 40', 'extra')).toBe('Extra $40 OFF');
  });

  it('does not suffix OFF when the prefix is Under or Below', () => {
    expect(formatDealDiscount('Rs. 2,000', 'under')).toBe('Under ₹2000');
    expect(formatDealDiscount('10 %', 'below')).toBe('Below 10%');
  });

  it('preserves unconverted legacy copy and empty values', () => {
    expect(formatDealDiscount('Buy one get one', null)).toBe('Buy one get one');
    expect(formatDealDiscount('56% OFF', undefined)).toBe('56% OFF');
    expect(formatDealDiscount('  ', 'flat')).toBeNull();
    expect(formatDealDiscount(null, 'flat')).toBeNull();
  });
});

describe('legacy Deal discount parsing', () => {
  it.each([
    ['FLAT ₹625 OFF', { discountPrefix: 'flat', discount: '₹625' }],
    ['Up to 50% Off', { discountPrefix: 'upTo', discount: '50%' }],
    ['UPTO $20 OFF', { discountPrefix: 'upTo', discount: '$20' }],
    ['EXTRA Rs. 100 OFF', { discountPrefix: 'extra', discount: '₹100' }],
    ['MIN 35%', { discountPrefix: 'min', discount: '35%' }],
    ['Under INR 2,000', { discountPrefix: 'under', discount: '₹2000' }],
    ['Below 10 % OFF', { discountPrefix: 'below', discount: '10%' }],
  ])('parses %s', (value, expected) => {
    expect(parseLegacyDealDiscount(value)).toEqual(expected);
    expect(migration.parseLegacyDiscount(value)).toEqual({
      discount_prefix: expected.discountPrefix,
      discount: expected.discount,
    });
  });

  it.each([
    '56% OFF',
    'Buy one get one',
    'Flat Free Shipping',
    '100',
    'Flat ₹ OFF',
    'Flat ₹,, OFF',
    'Flat Rs ,100 OFF',
  ])(
    'leaves unrecognized legacy value %s untouched',
    (value) => {
      expect(parseLegacyDealDiscount(value)).toBeNull();
      expect(migration.parseLegacyDiscount(value)).toBeNull();
    },
  );

  it('backfills recognizable rows once and preserves legacy exceptions', async () => {
    const rows: Array<Record<string, any>> = [
      { id: 1, discount: 'FLAT Rs. 1,250 OFF', discount_prefix: null },
      { id: 2, discount: 'Buy one get one', discount_prefix: null },
      { id: 3, discount: 'Extra 10% OFF', discount_prefix: 'extra' },
    ];
    const columns = new Set(['id', 'discount']);

    const knex: any = () => {
      const predicates: Array<(row: Record<string, any>) => boolean> = [];
      const query: any = {
        select() {
          return query;
        },
        where(values: Record<string, any>) {
          predicates.push((row) =>
            Object.entries(values).every(([key, value]) => row[key] === value),
          );
          return query;
        },
        whereNull(column: string) {
          predicates.push((row) => row[column] == null);
          return query;
        },
        whereNotNull(column: string) {
          predicates.push((row) => row[column] != null);
          return query;
        },
        async update(values: Record<string, any>) {
          let count = 0;
          for (const row of rows) {
            if (!predicates.every((predicate) => predicate(row))) continue;
            Object.assign(row, values);
            count++;
          }
          return count;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(rows.filter((row) => predicates.every((p) => p(row)))).then(resolve);
        },
      };
      return query;
    };
    knex.schema = {
      hasTable: vi.fn(async () => true),
      hasColumn: vi.fn(async (_table: string, column: string) => columns.has(column)),
      alterTable: vi.fn(async (_table: string, callback: (table: any) => void) => {
        callback({
          string(column: string) {
            columns.add(column);
            for (const row of rows) row[column] ??= null;
            return { nullable() {} };
          },
        });
      }),
    };

    await migration.up(knex);
    await migration.up(knex);

    expect(rows).toEqual([
      { id: 1, discount: '₹1250', discount_prefix: 'flat' },
      { id: 2, discount: 'Buy one get one', discount_prefix: null },
      { id: 3, discount: 'Extra 10% OFF', discount_prefix: 'extra' },
    ]);
  });
});
