import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The ONE place the bootstrap ordering invariant is asserted. The domain
// tests (search-migrations, content-contract-reconciliation,
// site-selection-reconciliation) each assert only that db-reconciliation.ts
// invokes their reconciler; this file proves index.ts runs the runner, and
// runs it before search starts serving.
describe('bootstrap database reconciliations', () => {
  it('runs the reconciliation runner before search initialization', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    const bootstrap = source.slice(source.indexOf('async bootstrap'));
    // Presence FIRST: indexOf returns -1 when the call is missing, and
    // -1 < any found index — without these guards the ordering assertion
    // below passes vacuously if either call is deleted.
    expect(bootstrap).toContain('runDatabaseReconciliations(strapi)');
    expect(bootstrap).toContain('initializeSearchRuntime(strapi)');
    expect(
      bootstrap.indexOf('runDatabaseReconciliations(strapi)'),
    ).toBeLessThan(bootstrap.indexOf('initializeSearchRuntime(strapi)'));
  });
});
