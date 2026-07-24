import type { Core } from '@strapi/strapi';
import type { IsrOutboxConfig } from './config';
import { logIsrOutbox } from './log';
import { IsrOutboxStore } from './store';
import type { IsrOutboxEvent } from './types';

const OUTBOX_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function deliveredRetentionCutoff(
  nowMs: number,
  retentionDays: number,
): Date {
  return new Date(nowMs - retentionDays * 24 * 60 * 60 * 1_000);
}

export async function cleanupDeliveredEvents(
  store: { deleteDeliveredBefore(cutoff: Date): Promise<number> },
  nowMs: number,
  retentionDays: number,
): Promise<
  | { state: 'cleaned'; deleted: number }
  | { state: 'failed'; error: Error }
> {
  try {
    return {
      state: 'cleaned',
      deleted: await store.deleteDeliveredBefore(
        deliveredRetentionCutoff(nowMs, retentionDays),
      ),
    };
  } catch (cause) {
    return {
      state: 'failed',
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }
}

export interface OutboxDeliveryStore {
  claim(): Promise<IsrOutboxEvent | null>;
  markDelivered(event: IsrOutboxEvent): Promise<void>;
  scheduleRetry(
    event: IsrOutboxEvent,
    error: string,
  ): Promise<{ attemptCount: number; delayMs: number }>;
}

export async function deliverOutboxEvent(
  event: IsrOutboxEvent,
  config: Pick<
    IsrOutboxConfig,
    'gatewayUrl' | 'adminSecret' | 'requestTimeoutMs'
  >,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchImpl(`${config.gatewayUrl}/revalidate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.adminSecret}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ eventKey: event.eventKey, ...event.payload }),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `gateway returned ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
}

export async function dispatchOne(
  store: OutboxDeliveryStore,
  deliver: (event: IsrOutboxEvent) => Promise<void>,
  onResult: (
    result:
      | { state: 'empty' }
      | { state: 'delivered'; event: IsrOutboxEvent }
      | {
          state: 'retry';
          event: IsrOutboxEvent;
          error: Error;
          attemptCount: number;
          delayMs: number;
        },
  ) => void = () => undefined,
): Promise<boolean> {
  const event = await store.claim();
  if (!event) {
    onResult({ state: 'empty' });
    return false;
  }
  try {
    await deliver(event);
    await store.markDelivered(event);
    onResult({ state: 'delivered', event });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const retry = await store.scheduleRetry(event, error.message);
    onResult({ state: 'retry', event, error, ...retry });
  }
  return true;
}

export class IsrOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private nextCleanupAt = 0;
  private readonly store: IsrOutboxStore;

  constructor(
    private readonly strapi: Core.Strapi,
    private readonly config: IsrOutboxConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.store = new IsrOutboxStore(
      strapi,
      config.leaseMs,
      config.maxBackoffMs,
    );
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
    logIsrOutbox(this.strapi, 'info', 'isr.outbox.dispatcher_started', {
      pollMs: this.config.pollMs,
      batchSize: this.config.batchSize,
    });
  }

  wake(): void {
    if (this.stopped || this.running) return;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.drain().finally(() => {
        this.running = null;
        this.schedule(this.config.pollMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    const now = Date.now();
    if (now >= this.nextCleanupAt) {
      this.nextCleanupAt = now + OUTBOX_CLEANUP_INTERVAL_MS;
      const cleanup = await cleanupDeliveredEvents(
        this.store,
        now,
        this.config.retentionDays,
      );
      if (cleanup.state === 'cleaned') {
        if (cleanup.deleted > 0) {
          logIsrOutbox(this.strapi, 'info', 'isr.outbox.cleanup_completed', {
            deleted: cleanup.deleted,
            retentionDays: this.config.retentionDays,
          });
        }
      } else {
        logIsrOutbox(this.strapi, 'error', 'isr.outbox.cleanup_failed', {
          error: cleanup.error.message,
        });
      }
    }

    for (let count = 0; count < this.config.batchSize; count += 1) {
      const found = await dispatchOne(
        this.store,
        (event) => deliverOutboxEvent(event, this.config, this.fetchImpl),
        (result) => {
          if (result.state === 'delivered') {
            logIsrOutbox(this.strapi, 'info', 'isr.outbox.delivered', {
              outboxId: result.event.id,
              eventKey: result.event.eventKey,
              reason: result.event.reason,
              attemptCount: result.event.attemptCount,
            });
          }
          if (result.state === 'retry') {
            const level =
              result.attemptCount >= this.config.alertAfterAttempts
                ? 'error'
                : 'warn';
            logIsrOutbox(this.strapi, level, 'isr.outbox.delivery_failed', {
              outboxId: result.event.id,
              eventKey: result.event.eventKey,
              reason: result.event.reason,
              attemptCount: result.attemptCount,
              retryInMs: result.delayMs,
              error: result.error.message,
              alert: level === 'error',
            });
          }
        },
      );
      if (!found) break;
    }
  }
}
