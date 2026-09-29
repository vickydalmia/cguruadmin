/** Server-side constants for the database backup module. */

export const DATABASE_BACKUP_RUNS_TABLE = 'database_backup_runs';

/** Core-store slot (`strapi_core_store_settings`) that holds the settings and
 * the runner heartbeat. Same mechanism as `src/translation/ui-dictionary`. */
export const DATABASE_BACKUP_STORE = { type: 'plugin', name: 'database-backup' } as const;
export const SETTINGS_STORE_KEY = 'settings';
export const RUNNER_STORE_KEY = 'runner';

export const RUNNER_TICK_MS = 30_000;
export const RUN_HEARTBEAT_MS = 15_000;
/** A running row whose heartbeat is older than this lost its worker. */
export const STALE_RUN_MS = 3 * 60_000;
/** Runner heartbeat older than this shows as unhealthy in the admin. */
export const RUNNER_UNHEALTHY_MS = 90_000;
export const MAX_RUN_ATTEMPTS = 2;
export const STDERR_TAIL_BYTES = 4_096;
export const ERROR_MAX_LENGTH = 4_000;
export const HISTORY_RETENTION_DAYS = 180;
export const RETENTION_SWEEP_MS = 24 * 60 * 60_000;
export const STALE_ALERT_MIN_GAP_MS = 24 * 60 * 60_000;
export const PRESIGNED_DOWNLOAD_SECONDS = 900;
export const KILL_GRACE_MS = 10_000;
/** A verification reads only the archive head; one that runs longer than this
 * is stuck (stalled download, wedged pg_restore) and is failed so the runner
 * can take the next backup. */
export const VERIFY_TIMEOUT_MS = 10 * 60_000;
/** Backup storage client: TCP connect budget, and the budget for one request
 * from first byte sent to response headers (an 8 MiB part must upload in it).
 * Without these the SDK waits forever on an endpoint that accepts the
 * connection and never answers. */
export const S3_CONNECTION_TIMEOUT_MS = 10_000;
export const S3_REQUEST_TIMEOUT_MS = 60_000;
export const UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const UPLOAD_QUEUE_SIZE = 2;
export const PG_DUMP_MAGIC = 'PGDMP';
export const CA_DIRECTORY = '.tmp/database-backup';
