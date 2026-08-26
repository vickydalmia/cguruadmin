export interface IsrOutboxConfig {
  enabled: boolean;
  gatewayUrl: string;
  adminSecret: string;
  pollMs: number;
  batchSize: number;
  requestTimeoutMs: number;
  leaseMs: number;
  maxBackoffMs: number;
  alertAfterAttempts: number;
  backlogAlertMs: number;
  retentionDays: number;
  maxPaths: number;
  maxPayloadBytes: number;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
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

export interface IsrOutboxPayloadBounds {
  maxPaths: number;
  maxPayloadBytes: number;
}

// Bounds for the payload written inside the content transaction. Deliberately
// independent of delivery configuration: a CMS save must never fail because
// the gateway URL or admin secret is wrong, and the content write path runs in
// environments (builds, tests) that carry no delivery credentials at all.
export function readOutboxPayloadBounds(): IsrOutboxPayloadBounds {
  return {
    maxPaths: integerEnv('ISR_REVALIDATE_MAX_PATHS', 5_000, 1, 100_000),
    maxPayloadBytes: integerEnv(
      'ISR_OUTBOX_MAX_PAYLOAD_BYTES',
      900_000,
      1_024,
      10_000_000,
    ),
  };
}

export function readIsrOutboxConfig(): IsrOutboxConfig {
  // CRON_ENABLED already identifies the single write/coordination process in
  // the two-container deployment. Inherit it when the dedicated switch is
  // absent so an existing host Compose file still disables delivery on
  // strapi-render as soon as the new image boots. The explicit switch wins and
  // supports deployments that intentionally separate cron from outbox work.
  const enabled = process.env.ISR_OUTBOX_DISPATCHER_ENABLED?.trim()
    ? booleanEnv('ISR_OUTBOX_DISPATCHER_ENABLED', true)
    : booleanEnv('CRON_ENABLED', true);
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
    enabled,
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
    // Undelivered events older than this flip /api/isr/status unhealthy and
    // emit isr.outbox.backlog_stale alerts. Healthy retries deliver within
    // ISR_OUTBOX_MAX_BACKOFF_MS (5 min default), so a 30-minute-old backlog
    // means delivery is genuinely stuck, not merely backing off.
    backlogAlertMs: integerEnv(
      'ISR_OUTBOX_BACKLOG_ALERT_MS',
      1_800_000,
      60_000,
      604_800_000,
    ),
    retentionDays: integerEnv('ISR_OUTBOX_RETENTION_DAYS', 30, 1, 365),
    ...readOutboxPayloadBounds(),
  };
}
