import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import type {
  IsrOutboxEvent,
  IsrOutboxInsert,
  IsrOutboxPayload,
} from './types';
import { readOutboxPayloadBounds } from './config';
import { boundOutboxPayload, hasOutboxWork } from './payload';

export const ISR_OUTBOX_TABLE = 'isr_outbox';

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
    ...(input.all === true ? { all: true as const } : {}),
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
  const inserted = await transaction(ISR_OUTBOX_TABLE)
    .insert({
      event_key: eventKey,
      payload: JSON.stringify(payload),
      reason: input.reason.slice(0, 255),
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: now,
      created_at: now,
    })
    .returning(['id', 'event_key']);
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
      const row = await trx(ISR_OUTBOX_TABLE)
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
        .orderBy('id', 'asc')
        .forUpdate()
        .skipLocked()
        .first();

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
            status: 'invalid',
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
    const delayMs = Math.min(
      this.maxBackoffMs,
      1_000 * 2 ** Math.min(attemptCount - 1, 12),
    );
    const updated = await this.strapi.db.connection(ISR_OUTBOX_TABLE)
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
  }

  async deleteDeliveredBefore(cutoff: Date): Promise<number> {
    return this.strapi.db.connection(ISR_OUTBOX_TABLE)
      .where({ status: 'delivered' })
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
        .min({ oldest: 'created_at' })
        .first(),
      connection(ISR_OUTBOX_TABLE)
        .where({ status: 'processing' })
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
