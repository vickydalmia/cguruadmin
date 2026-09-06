import { booleanEnv, integerEnv } from '../utils/env-parsers';

/**
 * Environment-driven configuration. Credentials live ONLY here (never in the
 * database that is itself being backed up). `readDatabaseBackupConfig()` never
 * throws for a missing value — the admin overview lists every problem so a
 * Super Admin can see why the runner refuses to start — but malformed
 * booleans/integers throw like every other background role.
 */

export type BackupSse = 'AES256' | 'aws:kms' | 'none';

export type DatabaseBackupConfig = {
  runnerEnabled: boolean;
  countryCode: string | null;
  s3: {
    bucket: string | null;
    region: string | null;
    prefix: string;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    endpoint: string | null;
    forcePathStyle: boolean;
    sse: BackupSse;
    kmsKeyId: string | null;
  };
  timeoutMinutes: number;
  pgDumpPath: string;
  pgRestorePath: string;
  compression: string;
};

function optionalString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** Trim slashes so `db-backups/` and `/db-backups` both become `db-backups`. */
export function normalisePrefix(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
}

function parseSse(raw: string | null): BackupSse {
  const value = (raw ?? 'AES256').trim();
  if (value === 'AES256' || value === 'aws:kms' || value === 'none') return value;
  throw new Error('BACKUP_S3_SSE must be AES256, aws:kms or none');
}

const COMPRESSION_PATTERN = /^(none|gzip|lz4|zstd)(:\d{1,2})?$|^\d{1,2}$/;

export function readDatabaseBackupConfig(): DatabaseBackupConfig {
  const compression = optionalString('BACKUP_PG_DUMP_COMPRESSION') ?? 'zstd:3';
  if (!COMPRESSION_PATTERN.test(compression)) {
    throw new Error('BACKUP_PG_DUMP_COMPRESSION must look like zstd:3, gzip:6, lz4 or none');
  }
  return {
    runnerEnabled: booleanEnv('BACKUP_RUNNER_ENABLED', false),
    countryCode: optionalString('DEPLOYMENT_COUNTRY_CODE')?.toUpperCase() ?? null,
    s3: {
      bucket: optionalString('BACKUP_S3_BUCKET'),
      region: optionalString('BACKUP_S3_REGION'),
      prefix: normalisePrefix(optionalString('BACKUP_S3_PREFIX') ?? 'db-backups'),
      accessKeyId: optionalString('BACKUP_S3_ACCESS_KEY_ID'),
      secretAccessKey: optionalString('BACKUP_S3_ACCESS_SECRET'),
      endpoint: optionalString('BACKUP_S3_ENDPOINT'),
      forcePathStyle: booleanEnv('BACKUP_S3_FORCE_PATH_STYLE', false),
      sse: parseSse(optionalString('BACKUP_S3_SSE')),
      kmsKeyId: optionalString('BACKUP_S3_KMS_KEY_ID'),
    },
    timeoutMinutes: integerEnv('BACKUP_TIMEOUT_MINUTES', 60, 1, 720),
    pgDumpPath: optionalString('BACKUP_PG_DUMP_PATH') ?? 'pg_dump',
    pgRestorePath: optionalString('BACKUP_PG_RESTORE_PATH') ?? 'pg_restore',
    compression,
  };
}

/**
 * Everything that must be present before a backup can be taken. Empty means
 * "configured". The wording is shown verbatim in the admin Storage tab.
 */
export function databaseBackupProblems(config: DatabaseBackupConfig): string[] {
  const problems: string[] = [];
  if (!config.s3.bucket) problems.push('BACKUP_S3_BUCKET is not set.');
  if (!config.s3.region && !config.s3.endpoint) {
    problems.push('BACKUP_S3_REGION is not set.');
  }
  if (!config.s3.accessKeyId) problems.push('BACKUP_S3_ACCESS_KEY_ID is not set.');
  if (!config.s3.secretAccessKey) problems.push('BACKUP_S3_ACCESS_SECRET is not set.');
  if (!config.countryCode || !/^[A-Z]{2}$/.test(config.countryCode)) {
    problems.push('DEPLOYMENT_COUNTRY_CODE must be a two-letter country code.');
  }
  if (config.s3.sse === 'aws:kms' && !config.s3.kmsKeyId) {
    problems.push('BACKUP_S3_KMS_KEY_ID is required when BACKUP_S3_SSE=aws:kms.');
  }
  if (config.s3.sse === 'none' && !config.s3.endpoint) {
    problems.push('BACKUP_S3_SSE=none is only allowed with a custom BACKUP_S3_ENDPOINT (local MinIO).');
  }
  return problems;
}

export function databaseBackupConfigured(config: DatabaseBackupConfig): boolean {
  return databaseBackupProblems(config).length === 0;
}

/** `AKIA…1234` — enough to recognise a key in the admin, never the secret. */
export function maskAccessKeyId(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
