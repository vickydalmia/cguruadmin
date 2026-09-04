import type { Core } from '@strapi/strapi';
import { readIsrOutboxConfig } from './config';
import { IsrOutboxDispatcher } from './dispatcher';
import { logIsrOutbox } from './log';
import { insertIsrOutboxEvent, ISR_OUTBOX_TABLE } from './store';
import type { IsrOutboxInsert } from './types';
import { purgeResponseCaches } from '../middlewares/cache';
import { purgeEntityPopularSearchCatalog } from '../api/store/services/entity-popular-searches';

let dispatcher: IsrOutboxDispatcher | null = null;

export const MINIMUM_PRODUCTION_ADMIN_SECRET_LENGTH = 16;

export function startIsrOutbox(strapi: Core.Strapi): void {
  const config = readIsrOutboxConfig();
  if (!config.enabled) {
    logIsrOutbox(strapi, 'info', 'isr.outbox.dispatcher_disabled', {
      reason: process.env.ISR_OUTBOX_DISPATCHER_ENABLED?.trim()
        ? 'ISR_OUTBOX_DISPATCHER_ENABLED=false'
        : 'CRON_ENABLED=false fallback',
    });
    return;
  }
  if (!config.gatewayUrl || !config.adminSecret) {
    const message =
      'ISR_GATEWAY_URL and ISR_ADMIN_SECRET are required for ISR outbox delivery';
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    logIsrOutbox(strapi, 'warn', 'isr.outbox.dispatcher_disabled', {
      reason: message,
    });
    return;
  }
  // Secret strength is a boot precondition, not a property of parsing the
  // environment. Keeping it here means a production image can still run its
  // test suite and build without being handed delivery credentials.
  if (
    process.env.NODE_ENV === 'production' &&
    config.adminSecret.length < MINIMUM_PRODUCTION_ADMIN_SECRET_LENGTH
  ) {
    throw new Error(
      `ISR_ADMIN_SECRET must be at least ${MINIMUM_PRODUCTION_ADMIN_SECRET_LENGTH} characters in production`,
    );
  }
  dispatcher = new IsrOutboxDispatcher(strapi, config);
  dispatcher.start();
}

export function wakeIsrOutbox(): void {
  dispatcher?.wake();
}

export async function stopIsrOutbox(): Promise<void> {
  await dispatcher?.stop();
  dispatcher = null;
}

export async function getIsrOutboxStatus() {
  if (!dispatcher) {
    return {
      ok: false,
      dispatcher: {
        running: false,
        stopped: true,
        stalled: true,
      },
      outbox: null,
    };
  }
  return dispatcher.status();
}

export async function enqueueStandaloneIsrEvent(
  strapi: Core.Strapi,
  input: IsrOutboxInsert,
): Promise<{ id: string; eventKey: string }> {
  return strapi.db.transaction(
    async ({ trx, onCommit }: { trx: any; onCommit: (fn: () => void) => void }) => {
      const event = await insertIsrOutboxEvent(trx, input);
      onCommit(() => {
        // Standalone events are used after cron/Query Engine writes, which do
        // not pass through the document middleware's after-commit purge. Wake
        // only after clearing API responses so ISR cannot rebuild durable HTML
        // from the pre-cleanup 60-second entity endpoint cache.
        purgeResponseCaches();
        purgeEntityPopularSearchCatalog();
        wakeIsrOutbox();
      });
      return event;
    },
  );
}

export type CoalescedIsrSweepResult =
  | { skipped: true; id: string; eventKey: string }
  | { skipped: false; id: string; eventKey: string };

/**
 * One full sweep per `reason` at a time. Pending rows are unique by event key,
 * while delivered history remains append-only. Coalescing is "skip while a PENDING
 * row with this reason exists", serialized by an advisory lock. A sweep
 * already PROCESSING may have read state from before the caller's write, so
 * only pending rows count. The skip path still purges the response caches —
 * the caller's write is visible either way.
 */
export async function enqueueCoalescedIsrSweep(
  strapi: Core.Strapi,
  input: { reason: string; scopes?: readonly string[] },
): Promise<CoalescedIsrSweepResult> {
  return strapi.db.transaction(
    async ({ trx, onCommit }: { trx: any; onCommit: (fn: () => void) => void }) => {
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
        `isr-sweep:${input.reason}`,
      ]);
      const pending = await trx(ISR_OUTBOX_TABLE)
        .where({ reason: input.reason, status: 'pending' })
        .select('id', 'event_key')
        .first();
      if (pending) {
        onCommit(() => purgeResponseCaches());
        return {
          skipped: true as const,
          id: String(pending.id),
          eventKey: String(pending.event_key ?? ''),
        };
      }
      const event = await insertIsrOutboxEvent(trx, {
        payload: {
          all: true,
          ...(input.scopes?.length ? { scopes: [...input.scopes] } : {}),
        },
        reason: input.reason,
      });
      onCommit(() => {
        purgeResponseCaches();
        purgeEntityPopularSearchCatalog();
        wakeIsrOutbox();
      });
      return { skipped: false as const, id: event.id, eventKey: event.eventKey };
    },
  );
}
