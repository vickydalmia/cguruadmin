import type { Core } from '@strapi/strapi';
import type { IsrOutboxConfig } from './config';
import { logIsrOutbox } from './log';
import { outboxPayloadSummary } from './payload';
import {
  IsrOutboxStore,
  type IsrOutboxClaim,
} from './store';
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
  claim(): Promise<IsrOutboxClaim | null>;
  markDelivered(event: IsrOutboxEvent, receipt?: unknown): Promise<boolean>;
  scheduleRetry(
    event: IsrOutboxEvent,
    error: string,
  ): Promise<{ owned: boolean; attemptCount: number; delayMs: number }>;
}

export async function deliverOutboxEvent(
  event: IsrOutboxEvent,
  config: Pick<
    IsrOutboxConfig,
    'gatewayUrl' | 'adminSecret' | 'requestTimeoutMs'
  >,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{
  paths: Array<{ path: string; version: number }>;
  removedPaths: string[];
  globalVersion?: number;
}> {
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
  const body = (await response.json().catch(() => null)) as any;
  const removedPaths = Array.isArray(body?.removedPaths)
    ? body.removedPaths.filter(
        (path: unknown): path is string => typeof path === 'string',
      )
    : [];
  const removed = new Set(removedPaths);
  const skippedPaths = Array.isArray(body?.skippedPaths)
    ? body.skippedPaths.filter(
        (path: unknown): path is string =>
          typeof path === 'string' && !removed.has(path),
      )
    : [];
  if (skippedPaths.length > 0) {
    throw new Error(
      `gateway skipped ${skippedPaths.length} path(s): ${skippedPaths.join(', ')}`,
    );
  }
  const paths = Array.isArray(body?.paths)
    ? body.paths.filter(
        (entry: any) =>
          entry &&
          typeof entry.path === 'string' &&
          Number.isSafeInteger(Number(entry.version)),
      )
    : [];
  return {
    paths: paths.map((entry: any) => ({
      path: entry.path,
      version: Number(entry.version),
    })),
    removedPaths,
    ...(Number.isSafeInteger(Number(body?.globalVersion))
      ? { globalVersion: Number(body.globalVersion) }
      : {}),
  };
}

export async function dispatchOne(
  store: OutboxDeliveryStore,
  deliver: (event: IsrOutboxEvent) => Promise<unknown>,
  onResult: (
    result:
      | { state: 'empty' }
      | { state: 'delivered'; event: IsrOutboxEvent }
      | {
          state: 'invalid';
          id: string;
          eventKey: string;
          error: string;
        }
      | {
          state: 'lease_lost';
          phase: 'delivered' | 'retry';
          event: IsrOutboxEvent;
        }
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
  if (event.state === 'invalid') {
    onResult(event);
    return true;
  }
  const claimed = event.event;
  try {
    const receipt = await deliver(claimed);
    const marked =
      receipt === undefined
        ? await store.markDelivered(claimed)
        : await store.markDelivered(claimed, receipt);
    if (marked) {
      onResult({ state: 'delivered', event: claimed });
    } else {
      onResult({
        state: 'lease_lost',
        phase: 'delivered',
        event: claimed,
      });
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const retry = await store.scheduleRetry(claimed, error.message);
    if (retry.owned) {
      onResult({ state: 'retry', event: claimed, error, ...retry });
    } else {
      onResult({
        state: 'lease_lost',
        phase: 'retry',
        event: claimed,
      });
    }
  }
  return true;
}

export class IsrOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private nextCleanupAt = 0;
  private readonly store: IsrOutboxStore;
  private readonly startedAt = Date.now();
  private lastCycleStartedAt = 0;
  private lastCycleCompletedAt = 0;
  private lastProgressAt = 0;
  private lastDeliveredAt = 0;
  private lastErrorAt = 0;
  private lastError: string | null = null;

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
      this.running = this.runCycle().finally(() => {
        this.running = null;
        this.schedule(this.config.pollMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    this.lastCycleStartedAt = Date.now();
    try {
      await this.drain();
      this.lastError = null;
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error(String(cause));
      this.lastErrorAt = Date.now();
      this.lastError = error.message;
      logIsrOutbox(
        this.strapi,
        'error',
        'isr.outbox.dispatcher_cycle_failed',
        { error: error.message },
      );
    } finally {
      this.lastCycleCompletedAt = Date.now();
    }
  }

  async status() {
    const outbox = await this.store.statusSummary();
    const now = Date.now();
    const staleAfterMs =
      this.config.requestTimeoutMs + Math.max(30_000, this.config.pollMs * 3);
    const cycleReference = Math.max(
      this.lastProgressAt,
      this.lastCycleCompletedAt,
      this.lastCycleStartedAt,
      this.startedAt,
    );
    const stalled = !this.stopped && now - cycleReference > staleAfterMs;
    const invalid = outbox.counts.invalid ?? 0;
    return {
      ok:
        !this.stopped &&
        !stalled &&
        invalid === 0 &&
        outbox.expiredProcessing === 0 &&
        this.lastError === null,
      dispatcher: {
        running: Boolean(this.running),
        stopped: this.stopped,
        startedAt: this.startedAt,
        lastCycleStartedAt: this.lastCycleStartedAt || null,
        lastCycleCompletedAt: this.lastCycleCompletedAt || null,
        lastProgressAt: this.lastProgressAt || null,
        lastDeliveredAt: this.lastDeliveredAt || null,
        lastErrorAt: this.lastErrorAt || null,
        lastError: this.lastError,
        stalled,
      },
      outbox,
    };
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
            this.lastDeliveredAt = Date.now();
            logIsrOutbox(this.strapi, 'info', 'isr.outbox.delivered', {
              outboxId: result.event.id,
              eventKey: result.event.eventKey,
              reason: result.event.reason,
              payload: outboxPayloadSummary(result.event.payload),
              attemptCount: result.event.attemptCount,
            });
          }
          if (result.state === 'invalid') {
            logIsrOutbox(this.strapi, 'error', 'isr.outbox.invalid', {
              outboxId: result.id,
              eventKey: result.eventKey,
              error: result.error,
              alert: true,
            });
          }
          if (result.state === 'lease_lost') {
            logIsrOutbox(this.strapi, 'warn', 'isr.outbox.lease_lost', {
              outboxId: result.event.id,
              eventKey: result.event.eventKey,
              reason: result.event.reason,
              phase: result.phase,
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
              payload: outboxPayloadSummary(result.event.payload),
              attemptCount: result.attemptCount,
              retryInMs: result.delayMs,
              error: result.error.message,
              alert: level === 'error',
            });
          }
        },
      );
      if (found) this.lastProgressAt = Date.now();
      if (!found) break;
    }
  }
}
