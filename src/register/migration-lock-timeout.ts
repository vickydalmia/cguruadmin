import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '@strapi/strapi';

/** User migrations are immutable. Apply a transaction-local lock policy at
 * registration, before Strapi loads/runs their cached CommonJS exports. */
export function installMigrationLockTimeout(strapi: Core.Strapi): void {
  const timeout = Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 15000);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) throw new Error('Invalid MIGRATION_LOCK_TIMEOUT_MS');
  const directory = join((strapi as any).dirs.app.root, 'database/migrations');
  for (const name of readdirSync(directory).filter((name) => /^2026\.09\..*\.js$/.test(name))) {
    const migration = require(join(directory, name));
    if (typeof migration.up !== 'function' || migration.up.lockTimeoutInstalled) continue;
    const up = migration.up;
    migration.up = async (trx: any, ...args: unknown[]) => {
      if (['pg', 'postgres', 'postgresql'].includes(trx.client.config.client)) {
        await trx.raw("SELECT set_config('lock_timeout', ?, true)", [`${timeout}ms`]);
      }
      return up(trx, ...args);
    };
    migration.up.lockTimeoutInstalled = true;
  }
}
