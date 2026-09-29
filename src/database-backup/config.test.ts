import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databaseBackupProblems, maskAccessKeyId, normalisePrefix, readDatabaseBackupConfig } from './config';

const KEYS = [
  'BACKUP_RUNNER_ENABLED', 'BACKUP_S3_BUCKET', 'BACKUP_S3_REGION', 'BACKUP_S3_PREFIX', 'BACKUP_S3_ACCESS_KEY_ID',
  'BACKUP_S3_ACCESS_SECRET', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_FORCE_PATH_STYLE', 'BACKUP_S3_SSE', 'BACKUP_S3_KMS_KEY_ID',
  'BACKUP_TIMEOUT_MINUTES', 'BACKUP_PG_DUMP_PATH', 'BACKUP_PG_RESTORE_PATH', 'BACKUP_PG_DUMP_COMPRESSION', 'DEPLOYMENT_COUNTRY_CODE',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function complete() {
  Object.assign(process.env, {
    BACKUP_S3_BUCKET: 'bucket', BACKUP_S3_REGION: 'ap-south-1', BACKUP_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEY1234',
    BACKUP_S3_ACCESS_SECRET: 'secret', DEPLOYMENT_COUNTRY_CODE: 'in',
  });
}

describe('readDatabaseBackupConfig', () => {
  it('applies defaults and normalises values', () => {
    complete();
    const config = readDatabaseBackupConfig();
    expect(config.runnerEnabled).toBe(false);
    expect(config.countryCode).toBe('IN');
    expect(config.s3.prefix).toBe('db-backups');
    expect(config.s3.sse).toBe('AES256');
    expect(config.timeoutMinutes).toBe(60);
    expect(config.compression).toBe('zstd:3');
    expect(config.pgDumpPath).toBe('pg_dump');
    expect(databaseBackupProblems(config)).toEqual([]);
  });

  it('rejects malformed values loudly', () => {
    complete();
    process.env.BACKUP_S3_SSE = 'kms';
    expect(() => readDatabaseBackupConfig()).toThrow('BACKUP_S3_SSE');
    process.env.BACKUP_S3_SSE = 'AES256';
    process.env.BACKUP_PG_DUMP_COMPRESSION = 'brotli';
    expect(() => readDatabaseBackupConfig()).toThrow('BACKUP_PG_DUMP_COMPRESSION');
    process.env.BACKUP_PG_DUMP_COMPRESSION = 'gzip:6';
    process.env.BACKUP_TIMEOUT_MINUTES = '0';
    expect(() => readDatabaseBackupConfig()).toThrow('BACKUP_TIMEOUT_MINUTES');
  });
});

describe('databaseBackupProblems', () => {
  it('lists every missing piece in admin-readable sentences', () => {
    const problems = databaseBackupProblems(readDatabaseBackupConfig());
    expect(problems).toEqual([
      'BACKUP_S3_BUCKET is not set.',
      'BACKUP_S3_REGION is not set.',
      'BACKUP_S3_ACCESS_KEY_ID is not set.',
      'BACKUP_S3_ACCESS_SECRET is not set.',
      'DEPLOYMENT_COUNTRY_CODE must be a two-letter country code.',
    ]);
  });

  it('requires a KMS key for aws:kms and an endpoint for sse=none', () => {
    complete();
    process.env.BACKUP_S3_SSE = 'aws:kms';
    expect(databaseBackupProblems(readDatabaseBackupConfig())).toEqual([
      'BACKUP_S3_KMS_KEY_ID is required when BACKUP_S3_SSE=aws:kms.',
    ]);
    process.env.BACKUP_S3_SSE = 'none';
    expect(databaseBackupProblems(readDatabaseBackupConfig())).toEqual([
      'BACKUP_S3_SSE=none is only allowed with a custom BACKUP_S3_ENDPOINT (local MinIO).',
    ]);
    process.env.BACKUP_S3_ENDPOINT = 'http://127.0.0.1:9000';
    delete process.env.BACKUP_S3_REGION;
    expect(databaseBackupProblems(readDatabaseBackupConfig())).toEqual([]);
  });
});

describe('helpers', () => {
  it('normalises prefixes and masks key ids', () => {
    expect(normalisePrefix('/db-backups/')).toBe('db-backups');
    expect(normalisePrefix(undefined)).toBe('');
    expect(maskAccessKeyId('AKIAEXAMPLEKEY1234')).toBe('AKIA…1234');
    expect(maskAccessKeyId('short')).toBe('sh…');
    expect(maskAccessKeyId(null)).toBeNull();
  });
});
