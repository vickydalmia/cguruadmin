/**
 * Database backups — the contract shared by the admin settings page and the
 * server module (`src/database-backup/`). Import-free on purpose: this file is
 * bundled into the admin panel, so it must not pull in Node or Strapi code.
 *
 * Mounted on the ADMIN router at `/database-backups` (no `/api` segment) behind
 * `admin::isAuthenticatedAdmin` + `global::super-admin-only`.
 */

export const DATABASE_BACKUP_ROUTE_PREFIX = '/database-backups';

/** Interval choices offered in the settings page. Every value divides 24 so
 * schedule slots stay aligned to UTC midnight (00/06/12/18 for 6 h). */
export const BACKUP_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export type BackupIntervalHours = (typeof BACKUP_INTERVAL_HOURS)[number];

export const BACKUP_NOTE_MAX_LENGTH = 200;
export const BACKUP_RUNS_PAGE_SIZE_MAX = 50;
export const BACKUP_RUNS_PAGE_SIZE_DEFAULT = 20;
export const BACKUP_DELETE_AFTER_DAYS_MAX = 3650;
/** Successful backups never pruned by retention, whatever their age. */
export const BACKUP_MINIMUM_KEPT = 3;

export type BackupRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'deleted';

export type BackupVerifyState = 'pending' | 'running' | 'ok' | 'failed';

export type BackupTrigger = 'scheduled' | 'manual';

export type BackupSettings = {
  scheduleEnabled: boolean;
  intervalHours: BackupIntervalHours;
  /** `null` = never delete automatically. */
  deleteAfterDays: number | null;
  autoVerify: boolean;
  /** `null` = no failure/stale alert emails. */
  alertEmail: string | null;
};

export const BACKUP_SETTINGS_DEFAULTS: BackupSettings = {
  scheduleEnabled: true,
  intervalHours: 6,
  deleteAfterDays: 7,
  autoVerify: false,
  alertEmail: null,
};

export type BackupRunView = {
  id: string;
  trigger: BackupTrigger;
  scheduleSlot: string | null;
  requestedById: number | null;
  requestedByLabel: string | null;
  note: string | null;
  status: BackupRunStatus;
  attemptCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  cancelRequestedAt: string | null;
  s3Bucket: string | null;
  s3Key: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  durationMs: number | null;
  pgDumpVersion: string | null;
  serverVersion: string | null;
  error: string | null;
  verifyState: BackupVerifyState | null;
  verifyRequestedAt: string | null;
  verifiedAt: string | null;
  verifyTocEntries: number | null;
  verifyError: string | null;
  deletedAt: string | null;
  deletedReason: string | null;
};

export type BackupRunnerStatus = {
  workerId: string | null;
  state: 'running' | 'idle' | 'disabled' | 'misconfigured' | 'unavailable';
  healthy: boolean;
  heartbeatAt: string | null;
  pgDumpVersion: string | null;
  serverVersion: string | null;
  problems: string[];
};

export type BackupStorageView = {
  configured: boolean;
  bucket: string | null;
  region: string | null;
  prefix: string | null;
  endpoint: string | null;
  sse: 'AES256' | 'aws:kms' | 'none' | null;
  kmsKeyId: string | null;
  accessKeyIdMasked: string | null;
  countryCode: string | null;
  problems: string[];
};

export type BackupOverview = {
  settings: BackupSettings;
  runner: BackupRunnerStatus;
  storage: BackupStorageView;
  activeRun: BackupRunView | null;
  lastSuccess: BackupRunView | null;
  nextScheduledAt: string | null;
  stale: boolean;
};

export type BackupRunsPage = {
  runs: BackupRunView[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
};

export type BackupConnectionCheck = {
  name: string;
  ok: boolean;
  detail: string | null;
};

export type BackupConnectionTest = {
  ok: boolean;
  latencyMs: number;
  checks: BackupConnectionCheck[];
};

export const BACKUP_RUN_ACTIVE_STATUSES: readonly BackupRunStatus[] = ['pending', 'running'];

export function isBackupIntervalHours(value: unknown): value is BackupIntervalHours {
  return (BACKUP_INTERVAL_HOURS as readonly number[]).includes(Number(value));
}
