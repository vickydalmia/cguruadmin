// React-free client helpers for the Super-Admin backfill controls on Country
// Setup: response unwrapping for /translation/backfill (real + dryRun) and
// /translation/outbox-status, plus the queue summary the card renders.
// Kept pure so the shapes are testable without the design system.

export type TranslationOutboxStatus = {
  enabled: boolean;
  ok?: boolean;
  dispatcher: {
    running: boolean;
    stopped: boolean;
    lastError: string | null;
    provider?: string;
    model?: string;
  } | null;
  outbox: {
    counts: Record<string, number>;
    deliveredToday: number;
    costTodayUsd: number;
    estimatedCostTodayUsd: number;
    dailyBudgetUsd: number | null;
    backlogOverdue?: boolean;
    historicalFailures?: number;
  } | null;
};

export type BackfillEstimate = {
  entries: number;
  translatableChars: number;
  estimatedCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedUsd: number;
  perUid: Record<string, number>;
  locales: string[];
  selected: number;
  skippedCurrent: number;
  providerCallsExpected: number;
};

export type BackfillResult = {
  selected: number;
  enqueued: number;
  skippedCurrent: number;
  providerCallsExpected: number;
  perUid: Record<string, number>;
  locales: string[];
};

export type QueueSummary = {
  pending: number;
  processing: number;
  failed: number;
  blocked: number;
  delivered: number;
  deliveredToday: number;
  costTodayUsd: number;
  dailyBudgetUsd: number | null;
};

function body(response: unknown): any {
  return (response as any)?.data?.data ?? (response as any)?.data ?? response;
}

export function unwrapOutboxStatus(response: unknown): TranslationOutboxStatus {
  const value = body(response);
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') {
    throw new Error('Translation status returned an unexpected response.');
  }
  return {
    enabled: value.enabled,
    ok: typeof value.ok === 'boolean' ? value.ok : undefined,
    dispatcher: value.dispatcher ?? null,
    outbox: value.outbox ?? null,
  };
}

export function unwrapBackfillEstimate(response: unknown): BackfillEstimate {
  const value = body(response);
  if (!value || typeof value !== 'object' || typeof value.estimatedUsd !== 'number') {
    throw new Error('Backfill estimate returned an unexpected response.');
  }
  return value as BackfillEstimate;
}

export function unwrapBackfillResult(response: unknown): BackfillResult {
  const value = body(response);
  if (!value || typeof value !== 'object' || typeof value.enqueued !== 'number') {
    throw new Error('Backfill returned an unexpected response.');
  }
  return value as BackfillResult;
}

const count = (counts: Record<string, number> | undefined, key: string) =>
  Number(counts?.[key] ?? 0) || 0;

export function queueSummary(status: TranslationOutboxStatus): QueueSummary {
  const counts = status.outbox?.counts;
  return {
    pending: count(counts, 'pending'),
    processing: count(counts, 'processing'),
    failed: count(counts, 'failed'),
    blocked: count(counts, 'blocked'),
    delivered: count(counts, 'delivered'),
    deliveredToday: Number(status.outbox?.deliveredToday ?? 0) || 0,
    costTodayUsd: Number(status.outbox?.costTodayUsd ?? 0) || 0,
    dailyBudgetUsd:
      typeof status.outbox?.dailyBudgetUsd === 'number' && status.outbox.dailyBudgetUsd > 0
        ? status.outbox.dailyBudgetUsd
        : null,
  };
}

/** Jobs still to be worked — the poll-while-busy signal. */
export function queueBusy(summary: QueueSummary): boolean {
  return summary.pending + summary.processing > 0;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(value)));
}

/** "api::coupon.coupon" → "coupon"; the dictionary keeps its own label. */
export function shortUid(uid: string): string {
  const match = /^api::[^.]+\.(.+)$/u.exec(uid);
  return match ? match[1] : uid;
}
