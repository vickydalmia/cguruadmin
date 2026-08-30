// Translation OUTBOX knobs, mirroring the ISR_OUTBOX_* family. Defaults are
// sized for LLM work: a lease long enough for a multi-chunk entry with
// retries, a backoff cap long enough that an empty provider account doesn't
// hammer anyone overnight.

export type TranslationOutboxConfig = {
  pollMs: number;
  batchSize: number;
  leaseMs: number;
  maxBackoffMs: number;
  retentionDays: number;
  alertAfterAttempts: number;
  backlogAlertMs: number;
  /** Retries granted to a job whose only failure is missing relation targets. */
  relationRetryMax: number;
};

function intFromEnv(name: string, fallback: number, minimum = 1): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function readTranslationOutboxConfig(): TranslationOutboxConfig {
  return {
    pollMs: intFromEnv('TRANSLATION_OUTBOX_POLL_MS', 5_000, 250),
    batchSize: intFromEnv('TRANSLATION_OUTBOX_BATCH_SIZE', 5),
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
    relationRetryMax: intFromEnv('TRANSLATION_RELATION_RETRY_MAX', 5),
  };
}
