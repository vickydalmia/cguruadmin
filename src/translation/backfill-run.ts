import { enabledContentLocales } from './locales/registry';
import { runInBackground } from '../background/execution-context';
// Durable, resumable catalogue scans. The runner role is independent from
// the paid translation dispatcher so deployments can isolate scans in a
// CPU-limited maintenance container.
import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import {
  enqueueTranslationBackfill,
  estimateTranslationBackfill,
  type BackfillCheckpoint,
  type BackfillMode,
  type BackfillOptions,
  type BackfillProgress,
  type BackfillResult,
} from './backfill';
import type { CostEstimate } from './cost';
import { isPostgresConnection } from '../utils/database-dialect';

export const TRANSLATION_BACKFILL_RUNS_TABLE = 'translation_backfill_runs';
const STALE_RUN_MS = 5 * 60_000;
const RUNNER_POLL_MS = 5_000;

export type BackfillRunStatus =
  | 'pending'
  | 'running'
  | 'cancelled'
  | 'done'
  | 'failed';

export type BackfillRunState = {
  id: string;
  mode: BackfillMode;
  dryRun: boolean;
  force: boolean;
  uids: string[] | null;
  locales: string[] | null;
  status: BackfillRunStatus;
  startedAt: string;
  heartbeatAt: string | null;
  finishedAt: string | null;
  progress: BackfillProgress;
  result: (BackfillResult & Partial<CostEstimate>) | null;
  error: string | null;
};

const runningIds = new Set<string>();
let runnerTimer: ReturnType<typeof setInterval> | null = null;
let runnerStrapi: Core.Strapi | null = null;
let runnerTicking = false;

class BackfillRunPausedError extends Error {}

class BackfillRunLeaseLostError extends Error {
  constructor() {
    super('backfill run was cancelled or its lease moved to another process');
    this.name = 'BackfillRunLeaseLostError';
  }
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/** Explicit role flag, with the old dispatcher/cron ownership as fallback. */
export function translationBackfillRunnerEnabled(): boolean {
  if (process.env.TRANSLATION_BACKFILL_RUNNER_ENABLED?.trim()) {
    return envBoolean(process.env.TRANSLATION_BACKFILL_RUNNER_ENABLED, false);
  }
  if (process.env.TRANSLATION_OUTBOX_DISPATCHER_ENABLED?.trim()) {
    return envBoolean(process.env.TRANSLATION_OUTBOX_DISPATCHER_ENABLED, false);
  }
  return envBoolean(process.env.CRON_ENABLED, true);
}

function isActiveRunConflict(cause: unknown): boolean {
  const code = String((cause as any)?.code ?? '');
  const message = String((cause as any)?.message ?? '');
  return code === '23505' || code.startsWith('SQLITE_CONSTRAINT') ||
    message.includes('translation_backfill_one_active_idx');
}

const emptyProgress = (): BackfillProgress => ({
  uidsTotal: 0,
  uidsDone: 0,
  currentUid: null,
  documentsScanned: 0,
  selected: 0,
  enqueued: 0,
  skippedCurrent: 0,
  skippedIneligible: 0,
});

function json<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stateFromRow(row: any): BackfillRunState {
  const request = json<Record<string, any>>(row.request, {});
  const rawStatus = String(row.status);
  const status: BackfillRunStatus = [
    'pending',
    'running',
    'cancelled',
    'done',
    'failed',
  ].includes(rawStatus)
    ? rawStatus as BackfillRunStatus
    : 'failed';
  return {
    id: String(row.id),
    mode: row.mode === 'repair' ? 'repair' : 'all',
    dryRun: row.dry_run === true || row.dry_run === 1,
    force: row.force === true || row.force === 1,
    uids: Array.isArray(request.uids) ? request.uids.map(String) : null,
    locales: Array.isArray(request.locales) ? request.locales.map(String) : null,
    status,
    startedAt: new Date(row.created_at).toISOString(),
    heartbeatAt: row.locked_at ? new Date(row.locked_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    progress: json<BackfillProgress>(row.progress, emptyProgress()),
    result: json<BackfillRunState['result']>(row.result, null),
    error: row.last_error ? String(row.last_error) : null,
  };
}

export type StartBackfillInput = Omit<
  BackfillOptions,
  'onProgress' | 'onCheckpoint' | 'checkpoint' | 'beforePage'
> & { dryRun?: boolean };

async function executeRun(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  input: StartBackfillInput,
  checkpoint: BackfillCheckpoint | null,
): Promise<void> {
  if (runningIds.has(id)) return;
  runningIds.add(id);
  try {
    const options: BackfillOptions = {
      beforePage: async () => {
        const pool = strapi.db.connection.client?.pool;
        const enabled = await enabledContentLocales(strapi);
        if (enabled.length === 0 || (pool?.numPendingAcquires?.() ?? 0) > 0 ||
            process.memoryUsage().rss > Number(process.env.TRANSLATION_BACKFILL_MAX_RSS_MB ?? (process.env.NODE_ENV === 'test' ? Infinity : 400)) * 1024 * 1024) {
          throw new BackfillRunPausedError();
        }
      },
      uids: input.uids,
      locales: input.locales,
      force: input.force,
      mode: input.mode,
      reason: input.reason,
      checkpoint,
      onCheckpoint: async (progress, nextCheckpoint) => {
        const updated = await strapi.db
          .connection(TRANSLATION_BACKFILL_RUNS_TABLE)
          .where({ id, status: 'running', lock_token: lockToken })
          .update({
            progress: JSON.stringify(progress),
            checkpoint: JSON.stringify(nextCheckpoint),
            locked_at: new Date(),
          });
        if (Number(updated) !== 1) throw new BackfillRunLeaseLostError();
      },
    };
    const result = input.dryRun
      ? await estimateTranslationBackfill(strapi, options)
      : await enqueueTranslationBackfill(strapi, options);
    const updated = await strapi.db
      .connection(TRANSLATION_BACKFILL_RUNS_TABLE)
      .where({ id, status: 'running', lock_token: lockToken })
      .update({
        status: 'done',
        result: JSON.stringify(result),
        finished_at: new Date(),
        locked_at: null,
        lock_token: null,
        last_error: null,
      });
    if (Number(updated) === 1) {
      strapi.log.info(
        `[translation] backfill ${id} ${input.dryRun ? 'estimate' : 'enqueue'} done: ` +
          `selected ${result.selected}, enqueued ${result.enqueued}, ` +
          `provider calls ${result.providerCallsExpected}`,
      );
    }
  } catch (cause) {
    if (cause instanceof BackfillRunPausedError) {
      await strapi.db.connection(TRANSLATION_BACKFILL_RUNS_TABLE)
        .where({ id, status: 'running', lock_token: lockToken })
        .update({ status: 'pending', locked_at: null, lock_token: null });
    } else if (cause instanceof BackfillRunLeaseLostError) {
      strapi.log.info(`[translation] backfill ${id} stopped after cancellation or lease loss`);
    } else {
      const error = cause instanceof Error ? cause.message : String(cause);
      await strapi.db
        .connection(TRANSLATION_BACKFILL_RUNS_TABLE)
        .where({ id, status: 'running', lock_token: lockToken })
        .update({
          status: 'failed',
          last_error: error.slice(0, 4_000),
          finished_at: new Date(),
          locked_at: null,
          lock_token: null,
        });
      strapi.log.error(`[translation] backfill ${id} failed: ${error}`);
    }
  } finally {
    runningIds.delete(id);
  }
}

function launchRun(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  input: StartBackfillInput,
  checkpoint: BackfillCheckpoint | null,
): void {
  void runInBackground(() => executeRun(strapi, id, lockToken, input, checkpoint));
}

function tickRunner(): Promise<void> {
  return runInBackground(tickRunnerClean);
}

let runnerGeneration = 0;

async function tickRunnerClean(): Promise<void> {
  if (!runnerStrapi || runnerTicking || runningIds.size > 0) return;
  runnerTicking = true;
  const strapi = runnerStrapi;
  const generation = runnerGeneration;
  try {
    if ((await enabledContentLocales(strapi)).length === 0) return;
    await resumeTranslationBackfillRun(strapi, () => runnerGeneration === generation && runnerStrapi === strapi);
  } catch (cause) {
    strapi.log.error(
      `[translation] backfill runner failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    runnerTicking = false;
  }
}

export function startTranslationBackfillRunner(strapi: Core.Strapi): void {
  if (!translationBackfillRunnerEnabled()) {
    strapi.log.info('[translation] backfill runner disabled on this process');
    return;
  }
  if (runnerStrapi === strapi) return;
  runnerGeneration += 1;
  runnerStrapi = strapi;
  strapi.log.info(`[translation] backfill runner started pid=${process.pid} generation=${runnerGeneration}`);
  if (!runnerTimer) {
    runnerTimer = runInBackground(() => setInterval(() => void tickRunner(), RUNNER_POLL_MS));
    runnerTimer.unref?.();
  }
  void tickRunner();
}

export function wakeTranslationBackfillRunner(): void {
  if (runnerStrapi) void tickRunner();
}

export async function currentBackfillRun(
  strapi: Core.Strapi,
): Promise<BackfillRunState | null> {
  const row = await strapi.db
    .connection(TRANSLATION_BACKFILL_RUNS_TABLE)
    .orderBy('created_at', 'desc')
    .first();
  return row ? stateFromRow(row) : null;
}

export async function backfillRunActive(strapi: Core.Strapi): Promise<boolean> {
  const row = await strapi.db
    .connection(TRANSLATION_BACKFILL_RUNS_TABLE)
    .whereIn('status', ['pending', 'running'])
    .first('id');
  return Boolean(row);
}

export async function startTranslationBackfill(
  strapi: Core.Strapi,
  input: StartBackfillInput,
): Promise<{ started: boolean; run: BackfillRunState }> {
  let created: { started: boolean; row: any };
  try {
    created = await strapi.db.transaction(async ({ trx }: any) => {
      const active = await trx(TRANSLATION_BACKFILL_RUNS_TABLE)
        .whereIn('status', ['pending', 'running'])
        .orderBy('created_at', 'asc')
        .first();
      if (active) return { started: false as const, row: active };

      const now = new Date();
      const normalized: StartBackfillInput = {
        ...input,
        mode: input.mode ?? 'all',
        force: input.force === true,
        dryRun: input.dryRun === true,
      };
      const row = {
        id: randomUUID(),
        mode: normalized.mode,
        dry_run: normalized.dryRun,
        force: normalized.force,
        request: JSON.stringify(normalized),
        status: 'pending',
        progress: JSON.stringify(emptyProgress()),
        checkpoint: null,
        result: null,
        last_error: null,
        locked_at: null,
        lock_token: null,
        created_at: now,
        finished_at: null,
      };
      await trx(TRANSLATION_BACKFILL_RUNS_TABLE).insert(row);
      return { started: true as const, row };
    });
  } catch (cause) {
    if (!isActiveRunConflict(cause)) throw cause;
    const active = await strapi.db
      .connection(TRANSLATION_BACKFILL_RUNS_TABLE)
      .whereIn('status', ['pending', 'running'])
      .orderBy('created_at', 'asc')
      .first();
    if (!active) throw cause;
    created = { started: false, row: active };
  }
  if (created.started) wakeTranslationBackfillRunner();
  return { started: created.started, run: stateFromRow(created.row) };
}

export async function cancelTranslationBackfill(
  strapi: Core.Strapi,
  id: string,
): Promise<{ cancelled: boolean; run: BackfillRunState | null }> {
  const cancelled = await strapi.db.transaction(async ({ trx }: any) => {
    const row = await trx(TRANSLATION_BACKFILL_RUNS_TABLE).where({ id }).first();
    if (!row) return null;
    if (!['pending', 'running'].includes(String(row.status))) {
      return { cancelled: false, row };
    }
    const updated = await trx(TRANSLATION_BACKFILL_RUNS_TABLE)
      .where({ id })
      .whereIn('status', ['pending', 'running'])
      .update({
        status: 'cancelled',
        finished_at: new Date(),
        locked_at: null,
        lock_token: null,
        last_error: null,
      });
    return {
      cancelled: Number(updated) === 1,
      row: await trx(TRANSLATION_BACKFILL_RUNS_TABLE).where({ id }).first(),
    };
  });
  if (!cancelled) return { cancelled: false, run: null };
  return { cancelled: cancelled.cancelled, run: stateFromRow(cancelled.row) };
}

/** Claim a pending or stale run. Checkpoints make stale recovery incremental. */
export function resumeTranslationBackfillRun(
  strapi: Core.Strapi,
  mayLaunch: () => boolean = () => true,
): Promise<boolean> {
  return runInBackground(() => resumeRun(strapi, mayLaunch));
}

async function resumeRun(strapi: Core.Strapi, mayLaunch: () => boolean): Promise<boolean> {
  const claimed = await strapi.db.transaction(async ({ trx }: any) => {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);
    let query = trx(TRANSLATION_BACKFILL_RUNS_TABLE)
      .where((builder: any) =>
        builder
          .where({ status: 'pending' })
          .orWhere((running: any) =>
            running.where({ status: 'running' }).where('locked_at', '<=', cutoff),
          ),
      )
      .orderBy('created_at', 'asc');
    if (isPostgresConnection(trx)) query = query.forUpdate().skipLocked();
    const row = await query.first();
    if (!row) return null;
    const lockToken = randomUUID();
    await trx(TRANSLATION_BACKFILL_RUNS_TABLE).where({ id: row.id }).update({
      status: 'running',
      lock_token: lockToken,
      locked_at: new Date(),
      finished_at: null,
      last_error: null,
    });
    return {
      id: String(row.id),
      lockToken,
      input: json<StartBackfillInput>(row.request, { mode: row.mode }),
      checkpoint: json<BackfillCheckpoint | null>(row.checkpoint, null),
    };
  });
  if (!claimed || !mayLaunch()) return false;
  launchRun(
    strapi,
    claimed.id,
    claimed.lockToken,
    claimed.input,
    claimed.checkpoint,
  );
  return true;
}

export function stopTranslationBackfillRecovery(): void {
  runnerGeneration += 1;
  if (runnerTimer) clearInterval(runnerTimer);
  runnerTimer = null;
  runnerStrapi = null;
}

/** Tests only. */
export function resetBackfillRunForTests(): void {
  stopTranslationBackfillRecovery();
  runningIds.clear();
}
