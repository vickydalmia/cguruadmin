import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const {
  HEADER_SEARCH_SUGGESTIONS,
  resolveLegacyPopularSearch,
  routeSlug,
  uniqueIds,
} = require('../../database/site-selection-reconciliation.js');

describe('site selection compatibility reconciliation', () => {
  const catalogs = {
    store: new Map([['amazon', 1]]),
    brand: new Map([['nike', 2], ['shared', 20]]),
    category: new Map([['fashion', 3], ['shared', 30]]),
    bank: new Map([['hdfc', 4]]),
  };

  it('retains the intended search overlay defaults', () => {
    expect(HEADER_SEARCH_SUGGESTIONS).toEqual([
      { text: 'Amazon Coupons', url: '/search/?q=Amazon' },
      { text: 'Flipkart Offers', url: '/search/?q=Flipkart' },
      { text: 'Myntra Coupons', url: '/search/?q=Myntra' },
      { text: 'Today’s Deals', url: '/deal-of-the-day/' },
    ]);
  });

  it('converts legacy relations and unambiguous canonical URLs', () => {
    expect(
      resolveLegacyPopularSearch(
        { url: '/nike/', storeIds: [9], categoryIds: [8] },
        catalogs,
      ),
    ).toEqual({ kind: 'store', id: 9 });
    expect(
      resolveLegacyPopularSearch({ url: '/brands/nike/' }, catalogs),
    ).toEqual({ kind: 'brand', id: 2 });
    expect(
      resolveLegacyPopularSearch({ url: '/shared/' }, catalogs),
    ).toBeNull();
    expect(
      resolveLegacyPopularSearch({ url: '/deal-of-the-day/' }, catalogs),
    ).toBeNull();
  });

  it('normalizes canonical routes and stable relation order', () => {
    expect(routeSlug('/stores/Amazon/')).toBe('amazon');
    expect(routeSlug('/too/many/parts/')).toBeNull();
    expect(uniqueIds([2, 1, 2], [3, -1, 1])).toEqual([2, 1, 3]);
  });

  it('runs after schema sync and before search starts serving', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    const bootstrap = source.slice(source.indexOf('async bootstrap'));
    expect(bootstrap).toContain('reconcileSiteSelectionsAfterSchemaSync(');
    expect(
      bootstrap.indexOf('reconcileSiteSelectionsAfterSchemaSync('),
    ).toBeLessThan(bootstrap.indexOf('initializeSearchRuntime(strapi)'));
  });

  it('has a guarded one-shot migration that delegates to the reconciler', () => {
    const source = readFileSync(
      resolve(
        __dirname,
        '../../database/migrations/2026.07.30T00.00.00.backfill-site-selections.js',
      ),
      'utf8',
    );
    expect(source).toContain('snapshotLegacyPopularSearchesBeforeSchemaSync(knex)');
    expect(source).toContain('reconcileSiteSelectionsAfterSchemaSync(knex)');
  });
});
