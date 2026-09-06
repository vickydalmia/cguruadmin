import type { Core } from '@strapi/strapi';

import type { BackupOverview, BackupRunnerStatus, BackupStorageView } from '../constants/database-backup';
import {
  databaseBackupProblems,
  maskAccessKeyId,
  readDatabaseBackupConfig,
  type DatabaseBackupConfig,
} from './config';
import { RUNNER_UNHEALTHY_MS } from './constants';
import { currentSlot, isBackupStale, isSlotSatisfied, nextScheduledRunAt } from './schedule';
import { readBackupSettings, readRunnerRecord } from './settings';
import { activeRunRow, lastSuccessfulRunRow, oldestRunRow, scheduledSlotExists, viewFromRow } from './store-rows';

/**
 * Everything the settings page shows on load. Runs in the admin container,
 * which has the same env file as the runner, so storage facts come from local
 * config while runner health comes from the heartbeat the maintenance
 * container writes to the core store.
 */

function storageView(config: DatabaseBackupConfig | null, problems: string[]): BackupStorageView {
  if (!config) {
    return {
      configured: false, bucket: null, region: null, prefix: null, endpoint: null, sse: null,
      kmsKeyId: null, accessKeyIdMasked: null, countryCode: null, problems,
    };
  }
  return {
    configured: problems.length === 0,
    bucket: config.s3.bucket,
    region: config.s3.region,
    prefix: config.s3.prefix,
    endpoint: config.s3.endpoint,
    sse: config.s3.sse,
    kmsKeyId: config.s3.kmsKeyId,
    accessKeyIdMasked: maskAccessKeyId(config.s3.accessKeyId),
    countryCode: config.countryCode,
    problems,
  };
}

async function runnerStatus(strapi: Core.Strapi, now: Date): Promise<BackupRunnerStatus> {
  const record = await readRunnerRecord(strapi);
  if (!record) {
    return {
      workerId: null, state: 'unavailable', healthy: false, heartbeatAt: null,
      pgDumpVersion: null, serverVersion: null, problems: [],
    };
  }
  const heartbeat = new Date(record.heartbeatAt);
  const fresh = !Number.isNaN(heartbeat.getTime()) && now.getTime() - heartbeat.getTime() < RUNNER_UNHEALTHY_MS;
  return {
    workerId: record.workerId,
    state: fresh ? record.state : 'unavailable',
    healthy: fresh && record.state !== 'misconfigured' && record.state !== 'disabled',
    heartbeatAt: record.heartbeatAt,
    pgDumpVersion: record.pgDumpVersion,
    serverVersion: record.serverVersion,
    problems: record.problems,
  };
}

export async function getDatabaseBackupOverview(strapi: Core.Strapi, now: Date = new Date()): Promise<BackupOverview> {
  let config: DatabaseBackupConfig | null = null;
  let configProblems: string[] = [];
  try {
    config = readDatabaseBackupConfig();
    configProblems = databaseBackupProblems(config);
  } catch (error) {
    configProblems = [String((error as Error)?.message ?? error)];
  }

  const [settings, runner, active, lastSuccess] = await Promise.all([
    readBackupSettings(strapi),
    runnerStatus(strapi, now),
    activeRunRow(strapi),
    lastSuccessfulRunRow(strapi),
  ]);

  const problems = Array.from(new Set([...configProblems, ...runner.problems]));
  const slot = currentSlot(now, settings.intervalHours);
  const lastSuccessStartedAt = lastSuccess?.started_at ? new Date(lastSuccess.started_at) : null;
  const currentSlotSatisfied = isSlotSatisfied({
    slot,
    slotRowExists: await scheduledSlotExists(strapi, slot),
    lastSuccessStartedAt,
  });
  const oldest = lastSuccess ? null : await oldestRunRow(strapi);

  return {
    settings,
    runner,
    storage: storageView(config, problems),
    activeRun: active ? viewFromRow(active) : null,
    lastSuccess: lastSuccess ? viewFromRow(lastSuccess) : null,
    nextScheduledAt: nextScheduledRunAt({ settings, now, currentSlotSatisfied })?.toISOString() ?? null,
    stale: isBackupStale({
      settings,
      now,
      lastSuccessAt: lastSuccessStartedAt,
      since: oldest?.created_at ? new Date(oldest.created_at) : null,
    }),
  };
}
