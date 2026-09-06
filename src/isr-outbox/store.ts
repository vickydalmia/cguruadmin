import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import type {
  IsrOutboxEvent,
  IsrOutboxInsert,
  IsrOutboxPayload,
} from './types';
import { readOutboxPayloadBounds } from './config';
import {
  boundOutboxPayload,
  hasOutboxWork,
  mergeOutboxPayloads,
} from './payload';
import {
  advisoryTransactionLock,
  isPostgresConnection,
} from '../utils/database-dialect';

export const ISR_OUTBOX_TABLE = 'isr_outbox';

/** Translation-wave debounce: slide by this much per merge … */
const TRANSLATION_DEBOUNCE_MS = 500;
/** … but never later than this after the pending row was created. */
const TRANSLATION_DEBOUNCE_MAX_MS = 5_000;

type Transaction = any;

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= 2_048,
    )
  ) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

export function parseIsrOutboxPayload(value: unknown): IsrOutboxPayload {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('payload must be an object');
  }
  const input = parsed as Record<string, unknown>;
  if (input.all !== undefined && input.all !== true) {
    throw new Error('payload.all must be true when present');
  }
  const paths = stringArray(input.paths, 'payload.paths');
  const optionalPaths = stringArray(
    input.optionalPaths,
    'payload.optionalPaths',
  );
  const scopes = stringArray(input.scopes, 'payload.scopes');
  if (input.inventoryLocale !== undefined && input.inventoryLocale !== 'en') throw new Error('Invalid inventoryLocale');
  if (input.manualRefresh !== undefined && input.manualRefresh !== true) throw new Error('Invalid manualRefresh');
  const excludeLocalePrefixes = stringArray(input.excludeLocalePrefixes, 'excludeLocalePrefixes');
  if (excludeLocalePrefixes !== undefined && (
    input.manualRefresh !== true || input.localePrefix !== undefined ||
    excludeLocalePrefixes.some((prefix) => !/^\/[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/iu.test(prefix))
  )) throw new Error('Invalid English language scope');
  const localePrefix = input.localePrefix;
  if (
    localePrefix !== undefined &&
    (typeof localePrefix !== 'string' || !/^\/[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/iu.test(localePrefix))
  ) {
    throw new Error('payload.localePrefix must be a normalized locale prefix');
  }
  const pathSet = new Set(paths ?? []);
  if (optionalPaths?.some((path) => !pathSet.has(path))) {
    throw new Error('payload.optionalPaths must be a subset of payload.paths');
  }
  let offerInvalidations: IsrOutboxPayload['offerInvalidations'];
  if (input.offerInvalidations !== undefined) {
    if (!Array.isArray(input.offerInvalidations)) {
      throw new Error('payload.offerInvalidations must be an array');
    }
    offerInvalidations = input.offerInvalidations.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('offer invalidation must be an object');
      }
      const offer = entry as Record<string, unknown>;
      if (
        !['coupon', 'deal'].includes(String(offer.entityType)) ||
        typeof offer.documentId !== 'string' ||
        !offer.documentId.trim()
      ) {
        throw new Error('offer invalidation is malformed');
      }
      return {
        entityType: offer.entityType as 'coupon' | 'deal',
        documentId: offer.documentId,
      };
    });
  }
  const payload: IsrOutboxPayload = {
    ...(input.manualRefresh === true ? { manualRefresh: true as const } : {}),
    ...(excludeLocalePrefixes !== undefined ? { excludeLocalePrefixes } : {}),
    ...(input.inventoryLocale === 'en' ? { inventoryLocale: 'en' as const } : {}),
    ...(input.all === true ? { all: true as const } : {}),
    ...(typeof localePrefix === 'string' ? { localePrefix } : {}),
    ...(paths?.length ? { paths } : {}),
    ...(optionalPaths?.length ? { optionalPaths } : {}),
    ...(scopes?.length ? { scopes } : {}),
    ...(offerInvalidations?.length ? { offerInvalidations } : {}),
  };
  if (!hasOutboxWork(payload)) {
    throw new Error('payload contains no invalidation work');
  }
  return payload;
}

function toEvent(row: any, lockToken: string): IsrOutboxEvent {
  return {
    id: String(row.id),
    deliveryKey: String(row.delivery_key ?? `${row.event_key}#${row.id}`),
    eventKey: row.event_key,
    lockToken,
    payload: parseIsrOutboxPayload(row.payload),
    reason: row.reason,
    attemptCount: Number(row.attempt_count),
  };
}

export type IsrOutboxClaim =
  | { state: 'event'; event: IsrOutboxEvent }
  | {
      state: 'invalid';
      id: string;
      eventKey: string;
      error: string;
    };

export interface IsrOutboxStatusSummary {
  counts: Record<string, number>;
  oldestUndeliveredAt: string | null;
  expiredProcessing: number;
}

export async function insertIsrOutboxEvent(
  transaction: Transaction,
  input: IsrOutboxInsert,
): Promise<{ id: string; eventKey: string; payload: IsrOutboxPayload }> {
  const eventKey = input.eventKey ?? randomUUID();
  const now = new Date();
  const bounds = readOutboxPayloadBounds();
  const payload = boundOutboxPayload(
    input.payload,
    bounds.maxPaths,
    bounds.maxPayloadBytes,
  );
  if (input.eventKey) {
    await advisoryTransactionLock(transaction, eventKey);
    let pendingQuery = transaction(ISR_OUTBOX_TABLE)
      .where({ event_key: eventKey, status: 'pending' });
    if (isPostgresConnection(transaction)) pendingQuery = pendingQuery.forUpdate();
    const pending = await pendingQuery.first();
    if (pending) {
      const merged = boundOutboxPayload(
        mergeOutboxPayloads(parseIsrOutboxPayload(pending.payload), payload),
        bounds.maxPaths,
        bounds.maxPayloadBytes,
      );
      // A short debounce turns large translation waves into a bounded number
      // of gateway versions without delaying editor-originated events. The
      // window is bounded from the row's creation: a wave that keeps writing
      // faster than the debounce must still flush, otherwise the one pending
      // row is never claimable and the locale stays stale for the whole run.
      const nextAttemptAt = eventKey.startsWith('translation-isr:')
        ? new Date(
            Math.min(
              Date.now() + TRANSLATION_DEBOUNCE_MS,
              new Date(pending.created_at ?? now).getTime() + TRANSLATION_DEBOUNCE_MAX_MS,
            ),
          )
        : new Date(pending.next_attempt_at ?? now);
      await transaction(ISR_OUTBOX_TABLE)
        .where({ id: pending.id, status: 'pending' })
        .update({
          payload: JSON.stringify(merged),
          reason: input.reason.slice(0, 255),
          next_attempt_at: nextAttemptAt,
        });
      return { id: String(pending.id), eventKey, payload: merged };
    }
  }
  const inserted = await transaction(ISR_OUTBOX_TABLE)
    .insert({
      delivery_key: randomUUID(),
      event_key: eventKey,
      payload: JSON.stringify(payload),
      reason: input.reason.slice(0, 255),
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: eventKey.startsWith('translation-isr:')
        ? new Date(now.getTime() + TRANSLATION_DEBOUNCE_MS)
        : now,
      created_at: now,
    })
    .returning(['id', 'event_key', 'delivery_key']);
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  return {
    id: String(row?.id ?? ''),
    eventKey: row?.event_key ?? eventKey,
    payload,
  };
}

export class IsrOutboxStore {
  constructor(
    private readonly strapi: Core.Strapi,
    private readonly leaseMs: number,
    private readonly maxBackoffMs: number,
  ) {}

  async claim(): Promise<IsrOutboxClaim | null> {
    return this.strapi.db.transaction(async ({ trx }: any) => {
      const now = new Date();
      const expiredLease = new Date(now.getTime() - this.leaseMs);
      let query = trx(ISR_OUTBOX_TABLE)
        .where((query: any) => {
          query
            .where((pending: any) => {
              pending
                .where('status', 'pending')
                .where('next_attempt_at', '<=', now);
            })
            .orWhere((processing: any) => {
              processing
                .where('status', 'processing')
                .where('locked_at', '<=', expiredLease);
            });
        })
        .orderBy('id', 'asc');
      if (isPostgresConnection(trx)) query = query.forUpdate().skipLocked();
      const row = await query.first();

      if (!row) return null;
      let payload: IsrOutboxPayload;
      try {
        payload = parseIsrOutboxPayload(row.payload);
      } catch (cause) {
        const error =
          cause instanceof Error ? cause.message : String(cause);
        await trx(ISR_OUTBOX_TABLE)
          .where({ id: row.id })
          .update({
            status: String(row.reason ?? '').startsWith('manual-refresh:') ? 'failed' : 'invalid',
            invalid_at: now,
            locked_at: null,
            lock_token: null,
            last_error: error.slice(0, 4_000),
          });
        return {
          state: 'invalid' as const,
          id: String(row.id),
          eventKey: String(row.event_key ?? ''),
          error,
        };
      }
      const lockToken = randomUUID();
      await trx(ISR_OUTBOX_TABLE)
        .where({ id: row.id })
        .update({
          status: 'processing',
          locked_at: now,
          lock_token: lockToken,
        });
      return {
        state: 'event' as const,
        event: toEvent({ ...row, payload }, lockToken),
      };
    });
  }

  async markDelivered(
    event: IsrOutboxEvent,
    receipt?: unknown,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.strapi.db.connection(ISR_OUTBOX_TABLE)
      .where({
        id: event.id,
        event_key: event.eventKey,
        status: 'processing',
        lock_token: event.lockToken,
      })
      .update({
        status: 'delivered',
        accepted_at: now,
        delivered_at: now,
        delivery_receipt:
          receipt === undefined ? null : JSON.stringify(receipt),
        locked_at: null,
        lock_token: null,
        last_error: null,
      });
    return Number(updated) === 1;
  }

  async scheduleRetry(
    event: IsrOutboxEvent,
    error: string,
  ): Promise<{ owned: boolean; attemptCount: number; delayMs: number }> {
    const attemptCount = event.attemptCount + 1;
    // Manual commands must not poison content delivery or later deployment
    // gates. Preserve the failed command for diagnosis and an explicit retry.
    if (event.payload.manualRefresh && (attemptCount >= 12 || /gateway returned (400|401|403|404|413)\b/.test(error))) {
      const updated = await this.strapi.db.connection(ISR_OUTBOX_TABLE)
        .where({ id: event.id, status: 'processing', lock_token: event.lockToken })
        .update({ status: 'failed', attempt_count: attemptCount, invalid_at: new Date(),
          locked_at: null, lock_token: null, last_error: error.slice(0, 4000) });
      return { owned: Number(updated) === 1, attemptCount, delayMs: 0 };
    }
    const delayMs = Math.min(
      this.maxBackoffMs,
      1_000 * 2 ** Math.min(attemptCount - 1, 12),
    );
    return this.strapi.db.transaction(async ({ trx }: any) => {
      // Serialize with keyed inserts. A newer write may have created a pending
      // row while this event was processing; blindly returning this row to
      // pending would violate the partial unique index. The newer row does not
      // necessarily cover the same paths, so merge the failed payload into it
      // before retiring this attempt as superseded.
      await advisoryTransactionLock(trx, event.eventKey);
      let newerPendingQuery = trx(ISR_OUTBOX_TABLE)
        .where({ event_key: event.eventKey, status: 'pending' })
        .whereNot({ id: event.id });
      if (isPostgresConnection(trx)) newerPendingQuery = newerPendingQuery.forUpdate();
      const newerPending = await newerPendingQuery.first();
      if (newerPending) {
        const bounds = readOutboxPayloadBounds();
        const merged = boundOutboxPayload(
          mergeOutboxPayloads(
            event.payload,
            parseIsrOutboxPayload(newerPending.payload),
          ),
          bounds.maxPaths,
          bounds.maxPayloadBytes,
        );
        await trx(ISR_OUTBOX_TABLE)
          .where({ id: newerPending.id, status: 'pending' })
          .update({
            payload: JSON.stringify(merged),
            attempt_count: Math.max(
              Number(newerPending.attempt_count ?? 0),
              attemptCount,
            ),
            next_attempt_at: new Date(Date.now() + delayMs),
            last_error: error.slice(0, 4_000),
          });
        const retired = await trx(ISR_OUTBOX_TABLE)
          .where({
            id: event.id,
            event_key: event.eventKey,
            status: 'processing',
            lock_token: event.lockToken,
          })
          .update({
            status: 'superseded',
            delivered_at: new Date(),
            locked_at: null,
            lock_token: null,
            last_error: error.slice(0, 4_000),
          });
        return {
          owned: Number(retired) === 1,
          attemptCount,
          delayMs,
        };
      }

      const updated = await trx(ISR_OUTBOX_TABLE)
        .where({
          id: event.id,
          event_key: event.eventKey,
          status: 'processing',
          lock_token: event.lockToken,
        })
        .update({
          status: 'pending',
          attempt_count: attemptCount,
          next_attempt_at: new Date(Date.now() + delayMs),
          locked_at: null,
          lock_token: null,
          last_error: error.slice(0, 4_000),
        });
      return { owned: Number(updated) === 1, attemptCount, delayMs };
    });
  }

  async deleteDeliveredBefore(cutoff: Date): Promise<number> {
    await this.strapi.db.connection(ISR_OUTBOX_TABLE)
      .where({ status: 'failed' }).where('invalid_at', '<', cutoff).delete();
    return this.strapi.db.connection(ISR_OUTBOX_TABLE)
      .whereIn('status', ['delivered', 'superseded'])
      .where('delivered_at', '<', cutoff)
      .delete();
  }

  async statusSummary(): Promise<IsrOutboxStatusSummary> {
    const connection = this.strapi.db.connection;
    const expiredLease = new Date(Date.now() - this.leaseMs);
    const [countRows, oldestRow, expiredRow] = await Promise.all([
      connection(ISR_OUTBOX_TABLE)
        .select('status')
        .count({ count: '*' })
        .groupBy('status'),
      connection(ISR_OUTBOX_TABLE)
        .whereIn('status', ['pending', 'processing'])
        .whereNot('reason', 'like', 'manual-refresh:%')
        .min({ oldest: 'created_at' })
        .first(),
      connection(ISR_OUTBOX_TABLE)
        .where({ status: 'processing' })
        .whereNot('reason', 'like', 'manual-refresh:%')
        .where('locked_at', '<=', expiredLease)
        .count({ count: '*' })
        .first(),
    ]);
    const counts = Object.fromEntries(
      (countRows as any[]).map((row) => [
        String(row.status),
        Number(row.count ?? 0),
      ]),
    );
    const oldest = (oldestRow as any)?.oldest;
    return {
      counts,
      oldestUndeliveredAt: oldest
        ? new Date(oldest).toISOString()
        : null,
      expiredProcessing: Number((expiredRow as any)?.count ?? 0),
    };
  }
}
