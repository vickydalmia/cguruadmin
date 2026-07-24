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
  maxPaths: number;
  maxPayloadBytes: number;
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
  const rawGatewayUrl =
    process.env.ISR_GATEWAY_URL?.trim().replace(/\/+$/, '') ?? '';
  let gatewayUrl = '';
  if (rawGatewayUrl) {
    const parsed = new URL(rawGatewayUrl);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('ISR_GATEWAY_URL must be an HTTP(S) URL without credentials, query, or hash');
    }
    gatewayUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }
  const adminSecret = process.env.ISR_ADMIN_SECRET?.trim() ?? '';
  if (process.env.NODE_ENV === 'production' && adminSecret.length < 16) {
    throw new Error(
      'ISR_ADMIN_SECRET must be at least 16 characters in production',
    );
  }
  const requestTimeoutMs = integerEnv(
    'ISR_OUTBOX_REQUEST_TIMEOUT_MS',
    90_000,
    1_000,
    120_000,
  );
  const leaseMs = integerEnv(
    'ISR_OUTBOX_LEASE_MS',
    120_000,
    10_000,
    600_000,
  );
  if (leaseMs < requestTimeoutMs + 30_000) {
    throw new Error(
      'ISR_OUTBOX_LEASE_MS must exceed ISR_OUTBOX_REQUEST_TIMEOUT_MS by at least 30000ms',
    );
  }
  return {
    gatewayUrl,
    adminSecret,
    pollMs: integerEnv('ISR_OUTBOX_POLL_MS', 2_000, 250, 60_000),
    batchSize: integerEnv('ISR_OUTBOX_BATCH_SIZE', 25, 1, 500),
    requestTimeoutMs,
    leaseMs,
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
    maxPaths: integerEnv('ISR_REVALIDATE_MAX_PATHS', 5_000, 1, 100_000),
    maxPayloadBytes: integerEnv(
      'ISR_OUTBOX_MAX_PAYLOAD_BYTES',
      900_000,
      1_024,
      10_000_000,
    ),
  };
}
