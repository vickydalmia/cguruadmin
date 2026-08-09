import type { Core } from '@strapi/strapi';
import { join } from 'node:path';

function databaseScriptPath(strapi: Core.Strapi, filename: string): string {
  return join((strapi as any).dirs.app.root, 'database', filename);
}

export async function reconcileDatabaseAfterSchemaSync(
  strapi: Core.Strapi,
): Promise<void> {
  const contentContractPath = databaseScriptPath(
    strapi,
    'content-contract-reconciliation.js',
  );
  const { reconcileContentContractAfterSchemaSync } = require(
    contentContractPath,
  );
  await reconcileContentContractAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log,
  );

  const siteSelectionPath = databaseScriptPath(
    strapi,
    'site-selection-reconciliation.js',
  );
  const { reconcileSiteSelectionsAfterSchemaSync } = require(siteSelectionPath);
  await reconcileSiteSelectionsAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log,
  );

  const festivalCategoryTabsPath = databaseScriptPath(
    strapi,
    'festival-category-tabs-reconciliation.js',
  );
  const { reconcileFestivalCategoryTabsAfterSchemaSync } = require(
    festivalCategoryTabsPath,
  );
  await reconcileFestivalCategoryTabsAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log,
  );

  const searchIndexMigrationPath = databaseScriptPath(
    strapi,
    'search-index-migration.js',
  );
  const { reconcileSearchIndexesAfterSchemaSync } = require(
    searchIndexMigrationPath,
  );
  await reconcileSearchIndexesAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log,
  );

  const uniqueCodeIntegrityPath = databaseScriptPath(
    strapi,
    'unique-code-integrity.js',
  );
  const { reconcileUniqueCodeIntegrityAfterSchemaSync } = require(
    uniqueCodeIntegrityPath,
  );
  await reconcileUniqueCodeIntegrityAfterSchemaSync(
    (strapi as any).db.connection,
    strapi.log,
  );
}
