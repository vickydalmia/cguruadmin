import { describe, expect, it } from 'vitest';

import type { DatabaseBackupConfig } from './config';
import { S3_CONNECTION_TIMEOUT_MS, S3_REQUEST_TIMEOUT_MS } from './constants';
import { backupObjectKey, compactTimestamp, createBackupS3Client, encryptionParams, sidecarKey } from './s3-client';

const config = (sse: DatabaseBackupConfig['s3']['sse'], kmsKeyId: string | null = null): DatabaseBackupConfig => ({
  runnerEnabled: true, countryCode: 'IN',
  s3: { bucket: 'b', region: 'r', prefix: 'db-backups', accessKeyId: 'k', secretAccessKey: 's', endpoint: null, forcePathStyle: false, sse, kmsKeyId },
  timeoutMinutes: 60, pgDumpPath: 'pg_dump', pgRestorePath: 'pg_restore', compression: 'zstd:3',
});

describe('backupObjectKey', () => {
  it('nests by country and UTC date and names the file after the run', () => {
    const key = backupObjectKey({
      prefix: 'db-backups', countryCode: 'in', at: new Date('2026-09-06T12:00:05Z'), runId: '3f2a9c1e-1111-2222-3333-444444444444',
    });
    expect(key).toBe('db-backups/IN/2026/09/06/IN-strapi-20260906T120005Z-3f2a9c1e.dump');
    expect(sidecarKey(key)).toBe(`${key}.sha256`);
  });

  it('tolerates an empty prefix', () => {
    expect(backupObjectKey({ prefix: '', countryCode: 'US', at: new Date('2026-01-02T03:04:05Z'), runId: 'abcdefgh-0000' }))
      .toBe('US/2026/01/02/US-strapi-20260102T030405Z-abcdefgh.dump');
  });
});

describe('compactTimestamp', () => {
  it('is UTC and zero-padded', () => {
    expect(compactTimestamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z');
  });
});

describe('encryptionParams', () => {
  it('maps the SSE setting onto PutObject parameters', () => {
    expect(encryptionParams(config('AES256'))).toEqual({ ServerSideEncryption: 'AES256' });
    expect(encryptionParams(config('aws:kms', 'key-1'))).toEqual({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'key-1' });
    expect(encryptionParams(config('none'))).toEqual({});
  });
});

describe('createBackupS3Client', () => {
  it('bounds every request with connection and request timeouts that throw', async () => {
    const client = createBackupS3Client(config('AES256'));
    const handler = client.config.requestHandler as { configProvider: Promise<Record<string, unknown>> };
    await expect(handler.configProvider).resolves.toMatchObject({
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    });
    expect(await client.config.maxAttempts()).toBe(3);
    client.destroy();
  });
});
