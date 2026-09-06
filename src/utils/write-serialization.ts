import { errors } from '@strapi/utils';
import type { Core } from '@strapi/strapi';

export type WriteLockDomain = 'identity' | 'redirect' | 'job';
let timeout: number | undefined;
export function readWriteSerializationTimeout(): number {
  const configured = Number(process.env.WRITE_SERIALIZATION_TIMEOUT_MS ?? 8000);
  if (!Number.isInteger(configured) || configured < 100 || configured > 60000) {
    throw new Error('WRITE_SERIALIZATION_TIMEOUT_MS must be between 100 and 60000');
  }
  return timeout = configured;
}

/** The caller owns this transaction through validation, content and outbox commit. */
export async function acquireWriteSerializationLock(
  strapi: Core.Strapi,
  domain: WriteLockDomain,
  trx: any,
): Promise<void> {
  const client = (strapi.db as any)?.connection?.client?.config?.client ?? '';
  if (!['pg', 'postgres', 'postgresql'].includes(client)) return;
  if (!trx) throw new Error('Write serialization requires the content transaction');
  // Lock errors must roll back, never weaken the cross-row invariants.
  const configured = process.env.NODE_ENV === 'test' ? readWriteSerializationTimeout() : timeout ?? readWriteSerializationTimeout();
  const previous = await trx.raw('SHOW lock_timeout');
  await trx.raw("SELECT set_config('lock_timeout', ?, true)", [`${configured}ms`]);
  try {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [
      'cguru:document-write', domain,
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') {
      throw new errors.ApplicationError('Another editor is saving related content. Your changes were not saved; please retry.');
    }
    throw error;
  }
  // Restore the caller's policy before content writes and outbox inserts.
  // On acquisition failure PostgreSQL aborts the transaction; do not issue SQL.
  await trx.raw("SELECT set_config('lock_timeout', ?, true)", [previous.rows[0].lock_timeout]);
}
