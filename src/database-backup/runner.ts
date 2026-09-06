import type { S3Client } from '@aws-sdk/client-s3';
import type { Core } from '@strapi/strapi';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { runInBackground } from '../background/execution-context';
import { booleanEnv } from '../utils/env-parsers';
import { sendBackupStaleAlert, staleBackupAlertDue } from './alerts';
import { databaseBackupConfigured, readDatabaseBackupConfig, type DatabaseBackupConfig } from './config';
import { CA_DIRECTORY, RETENTION_SWEEP_MS, RUNNER_TICK_MS } from './constants';
import { launchBackup, launchVerify, type ActiveJob, type RunnerContext } from './execute-run';
import { logDatabaseBackup } from './log';
import { buildPgInvocation, type PgInvocation } from './pg-connection';
import { materialiseCaFile, removeCaFiles } from './pg-dump';
import { runBackupPreflight } from './preflight';
import { reconcileReclaimedRun } from './reclaim';
import { applyRetention } from './retention';
import { createBackupS3Client } from './s3-client';
import { currentSlot, isBackupStale, isSlotSatisfied } from './schedule';
import { readBackupSettings, readRunnerRecord, writeRunnerRecord, type RunnerRecord } from './settings';
import { claimNextRun, claimVerify, enqueueRun, reclaimStaleRuns, reclaimStaleVerifications } from './store';
import { lastSuccessfulRunRow, oldestRunRow, scheduledSlotExists } from './store-rows';

/**
 * The single process that takes backups. Enabled per container by
 * `BACKUP_RUNNER_ENABLED` (true only on `strapi-maintenance` in compose).
 * Ticks every 30 s: heartbeat → reclaim stale leases → enqueue the due slot →
 * claim and launch one job → retention sweep → staleness alert. Work runs
 * detached so the tick keeps reporting health while a dump streams.
 *
 * Preflight failures do not stop the loop: the runner re-checks every five
 * minutes and starts working as soon as the bucket/tooling problem is fixed,
 * while the admin overview shows the problems verbatim.
 *
 * The exception is a runner whose `BACKUP_S3_*` / `DEPLOYMENT_COUNTRY_CODE`
 * environment is incomplete. That is static configuration a restart must fix,
 * so it is reported ONCE at boot (plus a daily reminder) instead of alerting
 * every five minutes for the life of the container.
 */

const PREFLIGHT_RETRY_MS = 5 * 60_000;
const UNCONFIGURED_REMINDER_MS = 24 * 60 * 60_000;
const STOP_WAIT_MS = 45_000;

type RunnerState = {
  strapi: Core.Strapi;
  config: DatabaseBackupConfig;
  client: S3Client | null;
  invocation: PgInvocation;
  caDirectory: string;
  workerId: string;
  generation: number;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  ready: boolean;
  /** Static environment problems; no retry can clear them without a restart. */
  unconfigured: boolean;
  lastUnconfiguredLogAt: number;
  problems: string[];
  versions: { pgDump: string | null; server: string | null };
  lastPreflightAt: number;
  /** The in-flight preflight, so boot and ticks never run two at once. */
  preflighting: Promise<void> | null;
  lastRetentionAt: number;
  active: ActiveJob | null;
  startedAt: Date;
};

let runner: RunnerState | null = null;
let generation = 0;

export function databaseBackupRunnerEnabled(): boolean {
  return booleanEnv('BACKUP_RUNNER_ENABLED', false);
}

function appRoot(strapi: Core.Strapi): string {
  return (strapi as any).dirs?.app?.root ?? process.cwd();
}

function preflight(state: RunnerState): Promise<void> {
  if (state.preflighting) return state.preflighting;
  state.preflighting = (async () => {
    try {
      const result = await runBackupPreflight({
        strapi: state.strapi,
        config: state.config,
        childEnv: state.invocation.childEnv,
        client: state.client,
      });
      state.ready = result.ok;
      state.problems = result.problems;
      state.versions = { pgDump: result.pgDumpVersion, server: result.serverVersion };
      if (!result.ok) {
        logMisconfigured(state, result.problems);
      } else {
        logDatabaseBackup(state.strapi, 'info', 'backup.runner_ready', {
          pgDump: result.pgDumpVersion, server: result.serverVersion, bucket: state.config.s3.bucket,
        });
      }
    } finally {
      state.lastPreflightAt = Date.now();
      state.preflighting = null;
    }
  })();
  return state.preflighting;
}

function logMisconfigured(state: RunnerState, problems: string[]): void {
  state.lastUnconfiguredLogAt = Date.now();
  logDatabaseBackup(state.strapi, 'error', 'backup.misconfigured', {
    alert: true,
    problems,
    ...(state.unconfigured
      ? {
          unconfigured: true,
          message:
            'BACKUP_RUNNER_ENABLED=true but the backup environment is incomplete; no backups will run '
            + 'until it is set and the container restarted. Backups are mandatory on every host; deploy.sh refuses this state.',
        }
      : {}),
  });
}

async function writeHeartbeat(state: RunnerState, previous: RunnerRecord | null): Promise<void> {
  await writeRunnerRecord(state.strapi, {
    workerId: state.workerId,
    state: !state.ready ? 'misconfigured' : state.active ? 'running' : 'idle',
    heartbeatAt: new Date().toISOString(),
    pgDumpVersion: state.versions.pgDump,
    serverVersion: state.versions.server,
    problems: state.problems,
    lastStaleAlertAt: previous?.lastStaleAlertAt ?? null,
  });
}

function context(state: RunnerState): RunnerContext {
  return {
    strapi: state.strapi,
    config: state.config,
    client: state.client!,
    invocation: state.invocation,
    versions: state.versions,
  };
}

function launch(state: RunnerState, job: ActiveJob): void {
  state.active = job;
  void job.done.catch((error) => {
    logDatabaseBackup(state.strapi, 'error', 'backup.job_crashed', {
      kind: job.kind, id: job.id, error: String((error as Error)?.message ?? error),
    });
  }).finally(() => {
    if (state.active === job) state.active = null;
    void tick();
  });
}

async function enqueueDueSlot(state: RunnerState, now: Date, intervalHours: number): Promise<void> {
  const slot = currentSlot(now, intervalHours);
  const lastSuccess = await lastSuccessfulRunRow(state.strapi);
  const satisfied = isSlotSatisfied({
    slot,
    slotRowExists: await scheduledSlotExists(state.strapi, slot),
    lastSuccessStartedAt: lastSuccess?.started_at ? new Date(lastSuccess.started_at) : null,
  });
  if (satisfied) return;
  const result = await enqueueRun(state.strapi, { trigger: 'scheduled', scheduleSlot: slot });
  if (result.created) {
    logDatabaseBackup(state.strapi, 'info', 'backup.scheduled', { runId: result.row.id, slot: slot.toISOString() });
  }
}

async function staleCheck(state: RunnerState, now: Date, settings: Awaited<ReturnType<typeof readBackupSettings>>, previous: RunnerRecord | null): Promise<void> {
  const lastSuccess = await lastSuccessfulRunRow(state.strapi);
  const oldest = lastSuccess ? null : await oldestRunRow(state.strapi);
  const stale = isBackupStale({
    settings,
    now,
    lastSuccessAt: lastSuccess?.started_at ? new Date(lastSuccess.started_at) : null,
    since: oldest?.created_at ? new Date(oldest.created_at) : null,
  });
  const lastAlertAt = previous?.lastStaleAlertAt ? new Date(previous.lastStaleAlertAt) : null;
  if (!staleBackupAlertDue({ now, stale, lastAlertAt })) return;
  await sendBackupStaleAlert(
    state.strapi,
    settings.alertEmail,
    lastSuccess?.started_at ? new Date(lastSuccess.started_at).toISOString() : null,
    state.config.countryCode,
  );
  const record = await readRunnerRecord(state.strapi);
  if (record && record.workerId === state.workerId) {
    await writeRunnerRecord(state.strapi, { ...record, lastStaleAlertAt: now.toISOString() });
  }
}

async function tickClean(): Promise<void> {
  const state = runner;
  if (!state || state.ticking) return;
  state.ticking = true;
  const myGeneration = state.generation;
  try {
    const now = new Date();
    if (state.lastPreflightAt === 0) {
      // First tick after boot: establish readiness (or the static problems)
      // once, off the bootstrap path.
      await preflight(state);
    } else if (state.unconfigured) {
      if (now.getTime() - state.lastUnconfiguredLogAt >= UNCONFIGURED_REMINDER_MS) {
        logMisconfigured(state, state.problems);
      }
    } else if (!state.ready && now.getTime() - state.lastPreflightAt >= PREFLIGHT_RETRY_MS) {
      await preflight(state);
    }
    const previous = await readRunnerRecord(state.strapi);
    const settings = await readBackupSettings(state.strapi);
    await writeHeartbeat(state, previous);
    if (!state.ready || !state.client || myGeneration !== generation) return;

    const bucket = state.config.s3.bucket!;
    for (const row of await reclaimStaleRuns(state.strapi, now)) {
      logDatabaseBackup(state.strapi, 'warn', 'backup.stale_reclaimed', { runId: row.id, worker: row.worker_id });
      // Committed archive → the row becomes a success; nothing committed →
      // abort the multipart and retry. Never a delete (see reclaim.ts).
      await reconcileReclaimedRun(context(state), row, settings.autoVerify);
    }
    for (const row of await reclaimStaleVerifications(state.strapi, now)) {
      logDatabaseBackup(state.strapi, 'warn', 'backup.verify_stale_reclaimed', { runId: row.id, key: row.s3_key });
    }

    if (settings.scheduleEnabled) await enqueueDueSlot(state, now, settings.intervalHours);

    if (!state.active) {
      const claim = await claimNextRun(state.strapi, state.workerId);
      if (claim && myGeneration === generation) launch(state, launchBackup(context(state), claim, settings));
    }
    if (!state.active) {
      const row = await claimVerify(state.strapi);
      if (row && myGeneration === generation) launch(state, launchVerify(context(state), row));
    }
    if (!state.active && now.getTime() - state.lastRetentionAt >= RETENTION_SWEEP_MS) {
      state.lastRetentionAt = now.getTime();
      await applyRetention(state.strapi, state.client, bucket, settings, now);
    }
    await staleCheck(state, now, settings, previous);
  } catch (error) {
    logDatabaseBackup(state.strapi, 'error', 'backup.tick_failed', { error: String((error as Error)?.message ?? error) });
  } finally {
    state.ticking = false;
  }
}

function tick(): Promise<void> {
  return runInBackground(tickClean);
}

export async function startDatabaseBackupRunner(strapi: Core.Strapi): Promise<void> {
  if (!databaseBackupRunnerEnabled()) {
    strapi.log.info('[database-backup] runner disabled on this process');
    return;
  }
  if (runner?.strapi === strapi) return;

  let config: DatabaseBackupConfig;
  try {
    config = readDatabaseBackupConfig();
  } catch (error) {
    logDatabaseBackup(strapi, 'error', 'backup.misconfigured', {
      alert: true, problems: [String((error as Error)?.message ?? error)],
    });
    return;
  }

  const caDirectory = path.join(appRoot(strapi), CA_DIRECTORY);
  const caSeed = createHash('sha256').update(process.env.DATABASE_SSL_CA ?? '').digest('hex').slice(0, 8);
  const invocation = buildPgInvocation(process.env as any, {
    compression: config.compression,
    caFilePath: path.join(caDirectory, `ca-${caSeed}.pem`),
  });
  if (invocation.caPem && invocation.ssl.mode === 'verify-full' && !invocation.caPath) {
    await materialiseCaFile(invocation.childEnv.PGSSLROOTCERT, invocation.caPem);
  }

  generation += 1;
  const state: RunnerState = {
    strapi,
    config,
    client: databaseBackupConfigured(config) ? createBackupS3Client(config) : null,
    invocation,
    caDirectory,
    workerId: `${process.pid}-${randomUUID().slice(0, 8)}`,
    generation,
    timer: null,
    ticking: false,
    ready: false,
    unconfigured: !databaseBackupConfigured(config),
    lastUnconfiguredLogAt: 0,
    problems: [],
    versions: { pgDump: null, server: null },
    lastPreflightAt: 0,
    preflighting: null,
    lastRetentionAt: 0,
    active: null,
    startedAt: new Date(),
  };
  runner = state;
  state.timer = runInBackground(() => setInterval(() => void tick(), RUNNER_TICK_MS));
  state.timer.unref?.();
  logDatabaseBackup(strapi, 'info', 'backup.runner_started', { workerId: state.workerId });
  // Strapi bootstrap must never wait on the backup bucket: the first tick
  // runs the preflight (S3 HeadBucket, pg_dump versions) in the background and
  // `backup.runner_ready` / `backup.misconfigured` report the outcome.
  void tick();
}

export function wakeDatabaseBackupRunner(): void {
  if (runner) void tick();
}

export async function stopDatabaseBackupRunner(): Promise<void> {
  const state = runner;
  if (!state) return;
  generation += 1;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  runner = null;
  if (state.active) {
    state.active.stop('shutdown');
    await Promise.race([
      state.active.done.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref?.()),
    ]);
  }
  await removeCaFiles(state.caDirectory);
  logDatabaseBackup(state.strapi, 'info', 'backup.runner_stopped', { workerId: state.workerId });
}

/** Tests only. */
export function resetDatabaseBackupRunnerForTests(): void {
  if (runner?.timer) clearInterval(runner.timer);
  runner = null;
  generation += 1;
}
