import type { Core } from '@strapi/strapi';

/**
 * One JSON line per event (same contract as `src/isr-outbox/log.ts`): Strapi's
 * logger renders an object first-argument as "[object Object]", and the log
 * collector keys alerts on `alert: true`.
 */
export function logDatabaseBackup(
  strapi: Core.Strapi,
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  (strapi.log[level] as any)(JSON.stringify({
    event,
    component: 'database-backup',
    ...fields,
  }));
}
