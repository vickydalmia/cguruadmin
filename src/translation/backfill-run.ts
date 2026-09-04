// Durable background execution of catalogue backfills and estimates. Run
// state lives in Postgres/SQLite so proxy timeouts, restarts, and another CMS
// process cannot hide or duplicate a scan.
import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import {
  enqueueTranslationBackfill,
  estimateTranslationBackfill,
  type BackfillMode,
  type BackfillOptions,
  type BackfillProgress,
  type BackfillResult,
} from './backfill';
import type { CostEstimate } from './cost';
import { isPostgresConnection } from '../utils/database-dialect';

export const TRANSLATION_BACKFILL_RUNS_TABLE = 'translation_backfill_runs';
const STALE_RUN_MS = 5 * 60_000;

export type BackfillRunStatus = 'running' | 'done' | 'failed';

export type BackfillRunState = {
  id: string;
  mode: BackfillMode;
  dryRun: boolean;
  force: boolean;
  uids: string[] | null;
  locales: string[] | null;
  status: BackfillRunStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: BackfillProgress;
  result: (BackfillResult & Partial<CostEstimate>) | null;
  error: string | null;
};

const runningIds = new Set<string>();
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

function isActiveRunConflict(cause: unknown): boolean {
  const code = String((cause as any)?.code ?? '');
  const message = String((cause as any)?.message ?? '');
  return code === '23505' || code.startsWith('SQLITE_CONSTRAINT') ||
    message.includes('translation_backfill_one_active_idx');
}

function launchRun(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  input: StartBackfillInput,
): void {
  void executeRun(strapi, id, lockToken, input).finally(() => {
    // If an operator queued a pending run directly, or another process left a
    // stale lease while this one was working, continue recovery immediately.
    void resumeTranslationBackfillRun(strapi);
  });
}

function scheduleResume(strapi: Core.Strapi, delayMs: number): void {
  if (resumeTimer) return;
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    void resumeTranslationBackfillRun(strapi).catch((cause) => {
      strapi.log.error(
        `[translation] backfill recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  }, Math.max(1_000, delayMs));
  resumeTimer.unref?.();
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
  return {
    id: String(row.id),
    mode: row.mode === 'repair' ? 'repair' : 'all',
    dryRun: row.dry_run === true || row.dry_run === 1,
    force: row.force === true || row.force === 1,
    uids: Array.isArray(request.uids) ? request.uids.map(String) : null,
    locales: Array.isArray(request.locales) ? request.locales.map(String) : null,
    status: row.status === 'failed' ? 'failed' : row.status === 'done' ? 'done' : 'running',
    startedAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    progress: json<BackfillProgress>(row.progress, emptyProgress()),
    result: json<BackfillRunState['result']>(row.result, null),
    error: row.last_error ? String(row.last_error) : null,
  };
}

export type StartBackfillInput = Omit<BackfillOptions, 'onProgress'> & {
  dryRun?: boolean;
};

async function executeRun(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  input: StartBackfillInput,
): Promise<void> {
  if (runningIds.has(id)) return;
  runningIds.add(id);
  let progressWrites = Promise.resolve();
  const onProgress = (progress: BackfillProgress) => {
    progressWrites = progressWrites.then(async () => {
      await strapi.db.connection(TRANSLATION_BACKFILL_RUNS_TABLE)
        .where({ id, status: 'running', lock_token: lockToken })
        .update({ progress: JSON.stringify(progress), locked_at: new Date() });
    });
  };
  try {
    const options = {
      uids: input.uids,
      locales: input.locales,
      force: input.force,
      mode: input.mode,
      reason: input.reason,
      onProgress,
    };
    const result = input.dryRun
      ? await estimateTranslationBackfill(strapi, options)
      : await enqueueTranslationBackfill(strapi, options);
    await progressWrites;
    await strapi.db.connection(TRANSLATION_BACKFILL_RUNS_TABLE)
      .where({ id, status: 'running', lock_token: lockToken })
      .update({
        status: 'done',
        result: JSON.stringify(result),
        finished_at: new Date(),
        locked_at: null,
        lock_token: null,
        last_error: null,
      });
    strapi.log.info(
      `[translation] backfill ${id} ${input.dryRun ? 'estimate' : 'enqueue'} done: ` +
        `selected ${result.selected}, enqueued ${result.enqueued}, ` +
        `provider calls ${result.providerCallsExpected}`,
    );
  } catch (cause) {
    await progressWrites.catch(() => undefined);
    const error = cause instanceof Error ? cause.message : String(cause);
    await strapi.db.connection(TRANSLATION_BACKFILL_RUNS_TABLE)
      .where({ id, status: 'running', lock_token: lockToken })
      .update({
        status: 'failed',
        last_error: error.slice(0, 4_000),
        finished_at: new Date(),
        locked_at: null,
        lock_token: null,
      });
    strapi.log.error(`[translation] backfill ${id} failed: ${error}`);
  } finally {
    runningIds.delete(id);
  }
}

export async function currentBackfillRun(
  strapi: Core.Strapi,
): Promise<BackfillRunState | null> {
  const row = await strapi.db.connection(TRANSLATION_BACKFILL_RUNS_TABLE)
    .orderBy('created_at', 'desc')
    .first();
  return row ? stateFromRow(row) : null;
}

export async function backfillRunActive(strapi: Core.Strapi): Promise<boolean> {
  const row = await strapi.db.connection(TRANSLATION_BACKFILL_RUNS_TABLE)
    .whereIn('status', ['pending', 'running'])
    .first('id');
  return Boolean(row);
}

export async function startTranslationBackfill(
  strapi: Core.Strapi,
  input: StartBackfillInput,
): Promise<{ started: boolean; run: BackfillRunState }> {
  let created: {
    started: boolean;
    row: any;
    input: StartBackfillInput | null;
  };
  try {
    created = await strapi.db.transaction(async ({ trx }: any) => {
      const active = await trx(TRANSLATION_BACKFILL_RUNS_TABLE)
        .whereIn('status', ['pending', 'running'])
        .orderBy('created_at', 'asc')
        .first();
      if (active) return { started: false as const, row: active, input: null };

      const id = randomUUID();
      const lockToken = randomUUID();
      const now = new Date();
      const normalized: StartBackfillInput = {
        ...input,
        mode: input.mode ?? 'all',
        force: input.force === true,
        dryRun: input.dryRun === true,
      };
      const row = {
        id,
        mode: normalized.mode,
        dry_run: normalized.dryRun,
        force: normalized.force,
        request: JSON.stringify(normalized),
        status: 'running',
        progress: JSON.stringify(emptyProgress()),
        result: null,
        last_error: null,
        locked_at: now,
        lock_token: lockToken,
        created_at: now,
        finished_at: null,
      };
      await trx(TRANSLATION_BACKFILL_RUNS_TABLE).insert(row);
      return { started: true as const, row, input: normalized };
    });
  } catch (cause) {
    // PostgreSQL's pending-only unique index is the final cross-process guard.
    // If two admin requests race after both observe no active row, return the
    // winner as the normal 409 response instead of surfacing a database 500.
    if (!isActiveRunConflict(cause)) throw cause;
    const active = await strapi.db.connection(TRANSLATION_BACKFILL_RUNS_TABLE)
      .whereIn('status', ['pending', 'running'])
      .orderBy('created_at', 'asc')
      .first();
    if (!active) throw cause;
    created = { started: false, row: active, input: null };
  }
  if (created.started && created.input) {
    launchRun(strapi, String(created.row.id), String(created.row.lock_token), created.input);
  }
  return { started: created.started, run: stateFromRow(created.row) };
}

/** Resume a stale run after process restart. Re-scanning is queue-idempotent. */
export async function resumeTranslationBackfillRun(strapi: Core.Strapi): Promise<boolean> {
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
      progress: JSON.stringify(emptyProgress()),
    });
    return {
      id: String(row.id),
      lockToken,
      input: json<StartBackfillInput>(row.request, { mode: row.mode }),
    };
  });
  if (!claimed) {
    // A newly restarted process may see a still-fresh lease from the dead
    // predecessor. Arrange another claim at lease expiry; a one-shot boot
    // check would otherwise strand the durable run forever.
    const active = await strapi.db.connection(TRANSLATION_BACKFILL_RUNS_TABLE)
      .where({ status: 'running' })
      .orderBy('locked_at', 'asc')
      .first('locked_at');
    if (active?.locked_at) {
      const dueAt = new Date(active.locked_at).getTime() + STALE_RUN_MS;
      scheduleResume(strapi, dueAt - Date.now());
    }
    return false;
  }
  launchRun(strapi, claimed.id, claimed.lockToken, claimed.input);
  return true;
}

export function stopTranslationBackfillRecovery(): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
}

/** Tests only. */
export function resetBackfillRunForTests(): void {
  stopTranslationBackfillRecovery();
  runningIds.clear();
}
