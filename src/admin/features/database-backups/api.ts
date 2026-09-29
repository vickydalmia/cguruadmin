import {
  BACKUP_RUNS_PAGE_SIZE_DEFAULT,
  DATABASE_BACKUP_ROUTE_PREFIX,
  type BackupConnectionTest,
  type BackupOverview,
  type BackupRunView,
  type BackupRunsPage,
  type BackupSettings,
} from '../../../constants/database-backup';

/**
 * Everything behind the Database Backups page that is worth testing, kept
 * React-free: request paths, response unwrapping, error wording, and the
 * formatting helpers the table uses. Components only render these.
 */

export const OVERVIEW_PATH = `${DATABASE_BACKUP_ROUTE_PREFIX}/overview`;
export const SETTINGS_PATH = `${DATABASE_BACKUP_ROUTE_PREFIX}/settings`;
export const TEST_CONNECTION_PATH = `${DATABASE_BACKUP_ROUTE_PREFIX}/test-connection`;
export const RUNS_PATH = `${DATABASE_BACKUP_ROUTE_PREFIX}/runs`;

export function runsPath(page: number, pageSize: number = BACKUP_RUNS_PAGE_SIZE_DEFAULT): string {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return `${RUNS_PATH}?${query.toString()}`;
}

export function runActionPath(id: string, action: 'cancel' | 'verify' | 'download-url'): string {
  return `${RUNS_PATH}/${encodeURIComponent(id)}/${action}`;
}

export function runPath(id: string): string {
  return `${RUNS_PATH}/${encodeURIComponent(id)}`;
}

/** Poll fast while something is happening, slowly otherwise. */
export const ACTIVE_POLL_MS = 3_000;
export const IDLE_POLL_MS = 30_000;

function body(response: unknown): any {
  return (response as any)?.data?.data ?? (response as any)?.data ?? response;
}

export function unwrapOverview(response: unknown): BackupOverview {
  const value = body(response);
  if (!value || typeof value !== 'object' || !value.settings || !value.runner || !value.storage) {
    throw new Error('Unexpected response from the backup overview endpoint.');
  }
  return value as BackupOverview;
}

export function unwrapRuns(response: unknown): BackupRunsPage {
  const value = body(response);
  if (!value || !Array.isArray(value.runs)) {
    throw new Error('Unexpected response from the backup history endpoint.');
  }
  return {
    runs: value.runs as BackupRunView[],
    page: Number(value.page) || 1,
    pageSize: Number(value.pageSize) || BACKUP_RUNS_PAGE_SIZE_DEFAULT,
    total: Number(value.total) || 0,
    pageCount: Math.max(1, Number(value.pageCount) || 1),
  };
}

export function unwrapRun(response: unknown): BackupRunView | null {
  const value = body(response);
  const run = value?.run ?? value;
  return run && typeof run === 'object' && typeof run.id === 'string' ? (run as BackupRunView) : null;
}

export function unwrapSettings(response: unknown): BackupSettings {
  const value = body(response);
  if (!value || typeof value !== 'object' || typeof value.intervalHours !== 'number') {
    throw new Error('Unexpected response from the backup settings endpoint.');
  }
  return value as BackupSettings;
}

export function unwrapConnectionTest(response: unknown): BackupConnectionTest {
  const value = body(response);
  if (!value || !Array.isArray(value.checks)) {
    throw new Error('Unexpected response from the connection test endpoint.');
  }
  return value as BackupConnectionTest;
}

export function unwrapDownloadUrl(response: unknown): string {
  const value = body(response);
  if (typeof value?.url !== 'string') throw new Error('No download link was returned.');
  return value.url;
}

/** Server problems first (validation list, then message), else the transport error. */
export function backupError(error: any, fallback = 'The request failed.'): string {
  const problems = error?.response?.data?.error?.details?.problems;
  if (Array.isArray(problems) && problems.length > 0) return problems.join(' ');
  return error?.response?.data?.error?.message ?? error?.message ?? fallback;
}

export function isForbidden(error: any): boolean {
  return error?.status === 403 || error?.response?.status === 403;
}

/** True while a poll should run fast: a backup or verification is in flight. */
export function activityInFlight(overview: BackupOverview | null, runs: BackupRunView[]): boolean {
  if (overview?.activeRun) return true;
  return runs.some((run) => run.verifyState === 'pending' || run.verifyState === 'running');
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** "12:00 UTC (17:30 local)" — the schedule is UTC-aligned, editors are not. */
export function formatScheduledAt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const utc = `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `${utc} (${date.toLocaleString()} local)`;
}

export function describeTrigger(run: Pick<BackupRunView, 'trigger' | 'requestedByLabel'>): string {
  if (run.trigger === 'scheduled') return 'Scheduled';
  return run.requestedByLabel ? `On-demand · ${run.requestedByLabel}` : 'On-demand';
}

export function elapsedSince(startedAt: string | null, now: number = Date.now()): number | null {
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  return Number.isNaN(started) ? null : Math.max(0, now - started);
}
