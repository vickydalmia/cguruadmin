import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import type {
  IsrOutboxEvent,
  IsrOutboxInsert,
  IsrOutboxPayload,
} from './types';

export const ISR_OUTBOX_TABLE = 'isr_outbox';

type Transaction = any;

function parsePayload(value: unknown): IsrOutboxPayload {
  if (typeof value === 'string') return JSON.parse(value);
  return value as IsrOutboxPayload;
}

function toEvent(row: any): IsrOutboxEvent {
  return {
    id: String(row.id),
    eventKey: row.event_key,
    payload: parsePayload(row.payload),
    reason: row.reason,
    attemptCount: Number(row.attempt_count),
  };
}

export async function insertIsrOutboxEvent(
  transaction: Transaction,
  input: IsrOutboxInsert,
): Promise<{ id: string; eventKey: string }> {
  const eventKey = input.eventKey ?? randomUUID();
  const now = new Date();
  const inserted = await transaction(ISR_OUTBOX_TABLE)
    .insert({
      event_key: eventKey,
      payload: JSON.stringify(input.payload),
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
  };
}

export class IsrOutboxStore {
  constructor(
    private readonly strapi: Core.Strapi,
    private readonly leaseMs: number,
    private readonly maxBackoffMs: number,
  ) {}

  async claim(): Promise<IsrOutboxEvent | null> {
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
      await trx(ISR_OUTBOX_TABLE)
        .where({ id: row.id })
        .update({ status: 'processing', locked_at: now });
      return toEvent(row);
    });
  }

  async markDelivered(event: IsrOutboxEvent): Promise<void> {
    await this.strapi.db.connection(ISR_OUTBOX_TABLE)
      .where({ id: event.id, event_key: event.eventKey })
      .update({
        status: 'delivered',
        delivered_at: new Date(),
        locked_at: null,
        last_error: null,
      });
  }

  async scheduleRetry(
    event: IsrOutboxEvent,
    error: string,
  ): Promise<{ attemptCount: number; delayMs: number }> {
    const attemptCount = event.attemptCount + 1;
    const delayMs = Math.min(
      this.maxBackoffMs,
      1_000 * 2 ** Math.min(attemptCount - 1, 12),
    );
    await this.strapi.db.connection(ISR_OUTBOX_TABLE)
      .where({ id: event.id, event_key: event.eventKey })
      .update({
        status: 'pending',
        attempt_count: attemptCount,
        next_attempt_at: new Date(Date.now() + delayMs),
        locked_at: null,
        last_error: error.slice(0, 4_000),
      });
    return { attemptCount, delayMs };
  }

  async deleteDeliveredBefore(cutoff: Date): Promise<number> {
    return this.strapi.db.connection(ISR_OUTBOX_TABLE)
      .where({ status: 'delivered' })
      .where('delivered_at', '<', cutoff)
      .delete();
  }
}
