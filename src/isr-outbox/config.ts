export interface IsrOutboxConfig {
  gatewayUrl: string;
  adminSecret: string;
  pollMs: number;
  batchSize: number;
  requestTimeoutMs: number;
  leaseMs: number;
  maxBackoffMs: number;
  alertAfterAttempts: number;
  retentionDays: number;
}

function integerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function readIsrOutboxConfig(): IsrOutboxConfig {
  return {
    gatewayUrl: process.env.ISR_GATEWAY_URL?.trim().replace(/\/+$/, '') ?? '',
    adminSecret: process.env.ISR_ADMIN_SECRET?.trim() ?? '',
    pollMs: integerEnv('ISR_OUTBOX_POLL_MS', 2_000, 250, 60_000),
    batchSize: integerEnv('ISR_OUTBOX_BATCH_SIZE', 25, 1, 500),
    requestTimeoutMs: integerEnv(
      'ISR_OUTBOX_REQUEST_TIMEOUT_MS',
      15_000,
      1_000,
      120_000,
    ),
    leaseMs: integerEnv('ISR_OUTBOX_LEASE_MS', 60_000, 10_000, 600_000),
    maxBackoffMs: integerEnv(
      'ISR_OUTBOX_MAX_BACKOFF_MS',
      300_000,
      1_000,
      3_600_000,
    ),
    alertAfterAttempts: integerEnv(
      'ISR_OUTBOX_ALERT_AFTER_ATTEMPTS',
      5,
      1,
      1_000,
    ),
    retentionDays: integerEnv('ISR_OUTBOX_RETENTION_DAYS', 30, 1, 365),
  };
}
