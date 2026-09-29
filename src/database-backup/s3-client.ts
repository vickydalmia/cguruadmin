import { S3Client } from '@aws-sdk/client-s3';

import type { DatabaseBackupConfig } from './config';
import { S3_CONNECTION_TIMEOUT_MS, S3_REQUEST_TIMEOUT_MS } from './constants';

/**
 * A dedicated client for the backup bucket. Static credentials from
 * `BACKUP_S3_*` only — the media bucket's `S3_*` key must never be able to
 * touch backups and vice versa.
 */
export function createBackupS3Client(config: DatabaseBackupConfig): S3Client {
  const { s3 } = config;
  if (!s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
    throw new Error('Database backup storage is not configured');
  }
  return new S3Client({
    region: s3.region ?? 'us-east-1',
    endpoint: s3.endpoint ?? undefined,
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    maxAttempts: 3,
    // Every call is bounded: the runner's preflight, uploads (per part),
    // deletes and the verification download must never hang on a silent
    // endpoint. Smithy only WARNS on requestTimeout unless told to throw.
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function compactTimestamp(at: Date): string {
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`
  );
}

/**
 * `<prefix>/<CC>/<YYYY>/<MM>/<DD>/<CC>-strapi-<YYYYMMDDTHHmmssZ>-<run8>.dump`
 * Date folders keep the console browsable; the country code appears twice so
 * a file copied out of its folder still says where it came from.
 */
export function backupObjectKey(input: {
  prefix: string;
  countryCode: string;
  at: Date;
  runId: string;
}): string {
  const country = input.countryCode.toUpperCase();
  const folder = [
    input.prefix,
    country,
    String(input.at.getUTCFullYear()),
    pad(input.at.getUTCMonth() + 1),
    pad(input.at.getUTCDate()),
  ]
    .filter((segment) => segment.length > 0)
    .join('/');
  const runFragment = input.runId.replace(/-/g, '').slice(0, 8);
  return `${folder}/${country}-strapi-${compactTimestamp(input.at)}-${runFragment}.dump`;
}

export function sidecarKey(key: string): string {
  return `${key}.sha256`;
}

/** SSE headers for every PutObject / multipart create. */
export function encryptionParams(config: DatabaseBackupConfig): {
  ServerSideEncryption?: 'AES256' | 'aws:kms';
  SSEKMSKeyId?: string;
} {
  if (config.s3.sse === 'none') return {};
  if (config.s3.sse === 'aws:kms') {
    return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.s3.kmsKeyId ?? undefined };
  }
  return { ServerSideEncryption: 'AES256' };
}
