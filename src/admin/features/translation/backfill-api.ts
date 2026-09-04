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
  backfill: BackfillRun | null;
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
  skippedIneligible: number;
  providerCallsExpected: number;
};

export type BackfillResult = {
  selected: number;
  enqueued: number;
  skippedCurrent: number;
  skippedIneligible: number;
  providerCallsExpected: number;
  perUid: Record<string, number>;
  locales: string[];
};

/** Progress of the background scan, as reported by the CMS run state. */
export type BackfillProgress = {
  uidsTotal: number;
  uidsDone: number;
  currentUid: string | null;
  documentsScanned: number;
  selected: number;
  enqueued: number;
  skippedCurrent: number;
  skippedIneligible: number;
};

/**
 * The durable database-backed run: POST /translation/backfill answers 202
 * with it (or 409 while one is active) and GET /translation/outbox-status
 * carries the latest one as `backfill` until a new run replaces it.
 */
export type BackfillRun = {
  id: string;
  mode: 'all' | 'repair';
  dryRun: boolean;
  force: boolean;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  progress: BackfillProgress;
  result: (BackfillResult & Partial<BackfillEstimate>) | null;
  error: string | null;
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
    backfill: unwrapBackfillRun(value.backfill),
  };
}

/** A run object from either endpoint; `null` when the CMS reports none. */
export function unwrapBackfillRun(value: unknown): BackfillRun | null {
  if (!value || typeof value !== 'object') return null;
  const run = value as any;
  if (
    typeof run.id !== 'string' ||
    !['running', 'done', 'failed'].includes(run.status) ||
    !run.progress ||
    typeof run.progress !== 'object'
  ) {
    return null;
  }
  return {
    id: run.id,
    mode: run.mode === 'repair' ? 'repair' : 'all',
    dryRun: run.dryRun === true,
    force: run.force === true,
    status: run.status,
    startedAt: String(run.startedAt ?? ''),
    finishedAt: typeof run.finishedAt === 'string' ? run.finishedAt : null,
    progress: {
      uidsTotal: Number(run.progress.uidsTotal ?? 0) || 0,
      uidsDone: Number(run.progress.uidsDone ?? 0) || 0,
      currentUid: typeof run.progress.currentUid === 'string' ? run.progress.currentUid : null,
      documentsScanned: Number(run.progress.documentsScanned ?? 0) || 0,
      selected: Number(run.progress.selected ?? 0) || 0,
      enqueued: Number(run.progress.enqueued ?? 0) || 0,
      skippedCurrent: Number(run.progress.skippedCurrent ?? 0) || 0,
      skippedIneligible: Number(run.progress.skippedIneligible ?? 0) || 0,
    },
    result: run.result && typeof run.result === 'object' ? run.result : null,
    error: typeof run.error === 'string' ? run.error : null,
  };
}

/** POST /translation/backfill: 202 `{ accepted, run }`. */
export function unwrapBackfillStart(response: unknown): BackfillRun {
  const value = body(response);
  const run = unwrapBackfillRun(value?.run);
  if (!run) throw new Error('Backfill start returned an unexpected response.');
  return run;
}

/** One line for the card while the scan runs. */
export function describeBackfillProgress(run: BackfillRun): string {
  const { progress } = run;
  const stage = progress.currentUid
    ? `scanning ${shortUid(progress.currentUid)} (${progress.uidsDone + 1}/${progress.uidsTotal})`
    : progress.uidsTotal > 0 && progress.uidsDone >= progress.uidsTotal
      ? 'finishing'
      : 'starting';
  const verb = run.dryRun ? 'Estimating' : 'Repairing';
  return (
    `${verb}: ${stage} — ${formatCount(progress.documentsScanned)} document(s) scanned, ` +
    `${formatCount(progress.selected)} selected` +
    (run.dryRun ? '' : `, ${formatCount(progress.enqueued)} queued`)
  );
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
