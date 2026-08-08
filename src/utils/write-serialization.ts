import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

// Cross-row invariants (one flat route slug across the four taxonomies,
// redirect duplicate/cycle detection) are validated with plain reads before an
// INDEPENDENT write commits, so two concurrent saves can both pass validation
// against the same committed snapshot and both commit. A unique index on the
// NORMALIZED values cannot be added over legacy duplicates (see
// identity-validation.ts), so mutual exclusion has to come from a lock: one
// Postgres transaction-scoped advisory lock per invariant domain, held on a
// dedicated connection across validate + commit. Editor saves are rare enough
// that domain-level (not per-key) serialization costs nothing, and it also
// covers the name-uniqueness and cycle checks a per-slug key would miss.

const LOCK_NAMESPACE = 'cguru:document-write';

export type WriteLockDomain = 'identity' | 'redirect' | 'job' | 'affiliate';

export type WriteLockRelease = () => Promise<void>;

/**
 * Serialize validate+commit for a write domain. Returns a release function,
 * or null when serialization is unavailable on a non-Postgres dialect (no
 * advisory locks exist there at all).
 *
 * What happens when Postgres HAS the lock but this caller cannot get it
 * (timeout behind a long holder, connection failure) depends on
 * `onUnavailable`:
 *  - 'open' (default): warn and return null — the caller proceeds
 *    unserialized. Fine for the slug/redirect uniqueness checks, whose race
 *    was always rare and merely re-creates a legacy-style duplicate.
 *  - 'closed': throw an editor-facing retryable error. Required for the
 *    affiliate domain — its lock guards a claimed data invariant, and a
 *    Brand cascade can legitimately hold it longer than the timeout; a
 *    waiter that proceeded unserialized could validate against the old flag
 *    and commit an invalid offer.
 */
export async function acquireWriteSerializationLock(
  strapi: Core.Strapi,
  domain: WriteLockDomain,
  options: { onUnavailable?: 'open' | 'closed' } = {},
): Promise<WriteLockRelease | null> {
  const knex = (strapi.db as any)?.connection;
  const client: string = knex?.client?.config?.client ?? '';
  if (!['pg', 'postgres', 'postgresql'].includes(client)) return null;

  let trx: any;
  try {
    trx = await knex.transaction();
    // A wedged holder must not queue every later save behind it forever;
    // advisory lock waits honor lock_timeout.
    await trx.raw("SET LOCAL lock_timeout = '8000ms'");
    // hashtext() keys the (int, int) advisory-lock form server-side, so the
    // key space needs no coordination beyond these two strings.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [
      LOCK_NAMESPACE,
      domain,
    ]);
  } catch (err: any) {
    if (trx) await trx.rollback().catch(() => {});
    if ((options.onUnavailable ?? 'open') === 'closed') {
      strapi.log.warn(
        `[write-lock] ${domain} advisory lock unavailable (${err?.message ?? err}) — rejecting the save (fail-closed domain)`
      );
      throw new errors.ApplicationError(
        'Another save touching related records is still in progress. ' +
          'Nothing was saved — wait a few seconds and try again.',
      );
    }
    strapi.log.warn(
      `[write-lock] ${domain} advisory lock unavailable (${err?.message ?? err}) — proceeding unserialized`
    );
    return null;
  }

  return async () => {
    // Commit ends the transaction, which releases the xact lock. Nothing was
    // written on this connection, so commit vs rollback is equivalent —
    // commit keeps rollback metrics clean.
    await trx.commit().catch(() => {});
  };
}
