// Translation OUTBOX knobs, mirroring the ISR_OUTBOX_* family. Defaults are
// sized for LLM work: a lease long enough for a multi-chunk entry with
// retries, a backoff cap long enough that an empty provider account doesn't
// hammer anyone overnight.

export type TranslationOutboxConfig = {
  /** Exactly one CMS process should lease and deliver paid translation jobs. */
  enabled: boolean;
  pollMs: number;
  batchSize: number;
  leaseMs: number;
  maxBackoffMs: number;
  retentionDays: number;
  alertAfterAttempts: number;
  backlogAlertMs: number;
  /** Durable full-job retries after writer/editor corrective passes fail. */
  qualityRetryMax: number;
};

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * The document middleware is the normal incremental trigger. A nightly
 * durable repair scan is an optional recovery tool because proving current
 * rows still costs database reads; large sites must opt into that load.
 */
export function translationNightlyConsistencyEnabled(): boolean {
  return booleanFromEnv('TRANSLATION_NIGHTLY_CONSISTENCY_ENABLED', false);
}

function intFromEnv(name: string, fallback: number, minimum = 1): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function readTranslationOutboxConfig(): TranslationOutboxConfig {
  // CRON_ENABLED already marks the single coordination process in the
  // two-container deployment. Inherit it for older host Compose files; the
  // dedicated switch wins when translation work is intentionally separated.
  const enabled = process.env.TRANSLATION_OUTBOX_DISPATCHER_ENABLED?.trim()
    ? booleanFromEnv('TRANSLATION_OUTBOX_DISPATCHER_ENABLED', true)
    : booleanFromEnv('CRON_ENABLED', true);
  return {
    enabled,
    pollMs: intFromEnv('TRANSLATION_OUTBOX_POLL_MS', 5_000, 250),
    batchSize: intFromEnv('TRANSLATION_OUTBOX_BATCH_SIZE', 2),
    leaseMs: intFromEnv('TRANSLATION_OUTBOX_LEASE_MS', 15 * 60 * 1_000, 10_000),
    maxBackoffMs: intFromEnv(
      'TRANSLATION_OUTBOX_MAX_BACKOFF_MS',
      6 * 60 * 60 * 1_000,
      1_000,
    ),
    retentionDays: intFromEnv('TRANSLATION_OUTBOX_RETENTION_DAYS', 30),
    alertAfterAttempts: intFromEnv('TRANSLATION_OUTBOX_ALERT_AFTER_ATTEMPTS', 5),
    backlogAlertMs: intFromEnv(
      'TRANSLATION_OUTBOX_BACKLOG_ALERT_MS',
      60 * 60 * 1_000,
      60_000,
    ),
    qualityRetryMax: intFromEnv('TRANSLATION_QUALITY_RETRY_MAX', 1, 0),
  };
}
