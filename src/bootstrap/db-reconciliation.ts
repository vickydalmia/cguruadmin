import type { Core } from '@strapi/strapi';
import { join } from 'node:path';

// User migrations run before Strapi's schema sync, so fresh databases do
// not have the search tables when those migrations first execute. Retry
// the same structural reconciliation here on every boot, after schema
// sync. Healthy indexes are inspection-only; optional DDL failures are
// logged and retried on the next boot without making Strapi unavailable.
// Resolve from the application root rather than this compiled module's
// directory: production runs dist/src/*.js while Strapi migrations
// remain under <app>/database.
export async function runDatabaseReconciliations(strapi: Core.Strapi): Promise<void> {
  const contentContractPath = join(
    (strapi as any).dirs.app.root,
    'database',
    'content-contract-reconciliation.js'
  );
  const { reconcileContentContractAfterSchemaSync } = require(
    contentContractPath
  );
  await reconcileContentContractAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log
  );

  const siteSelectionPath = join(
    (strapi as any).dirs.app.root,
    'database',
    'site-selection-reconciliation.js'
  );
  const { reconcileSiteSelectionsAfterSchemaSync } = require(
    siteSelectionPath
  );
  await reconcileSiteSelectionsAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log
  );

  // This page originally reused the Homepage category component. It now has
  // a festival-only component so Content Manager can enforce max: 4 without
  // reducing Homepage's eight-tab allowance. Preserve already-authored tabs
  // after the new component tables exist; repeated boots are a no-op.
  const festivalCategoryTabsPath = join(
    (strapi as any).dirs.app.root,
    'database',
    'festival-category-tabs-reconciliation.js'
  );
  const { reconcileFestivalCategoryTabsAfterSchemaSync } = require(
    festivalCategoryTabsPath
  );
  await reconcileFestivalCategoryTabsAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log
  );

  const searchIndexMigrationPath = join(
    (strapi as any).dirs.app.root,
    'database',
    'search-index-migration.js'
  );
  const { reconcileSearchIndexesAfterSchemaSync } = require(
    searchIndexMigrationPath
  );
  await reconcileSearchIndexesAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log
  );
  const uniqueCodeIntegrityPath = join(
    (strapi as any).dirs.app.root,
    'database',
    'unique-code-integrity.js'
  );
  const { reconcileUniqueCodeIntegrityAfterSchemaSync } = require(
    uniqueCodeIntegrityPath
  );
  await reconcileUniqueCodeIntegrityAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log
  );
}
