import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { BackupConnectionCheck, BackupConnectionTest } from '../constants/database-backup';
import type { DatabaseBackupConfig } from './config';
import { PRESIGNED_DOWNLOAD_SECONDS } from './constants';
import { encryptionParams, sidecarKey } from './s3-client';

/** Small object-level operations the runner and the admin endpoints share. */

export type BackupObjectHead =
  | { exists: true; sizeBytes: number | null; etag: string | null }
  | { exists: false; sizeBytes: null; etag: null };

export async function headBackupObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<BackupObjectHead> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      exists: true,
      sizeBytes: typeof head.ContentLength === 'number' ? head.ContentLength : null,
      etag: head.ETag ?? null,
    };
  } catch (error: any) {
    if (isMissingObject(error)) return { exists: false, sizeBytes: null, etag: null };
    throw error;
  }
}

function isMissingObject(error: any): boolean {
  return error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;
}

/** The sha256 recorded in the `.sha256` sidecar, or null when there is no
 * sidecar (the uploader died between the object commit and writing it). */
export async function readSidecarSha256(client: S3Client, bucket: string, key: string): Promise<string | null> {
  let body: string;
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: sidecarKey(key) }));
    body = (await response.Body?.transformToString()) ?? '';
  } catch (error: any) {
    if (isMissingObject(error)) return null;
    throw error;
  }
  const match = /^([0-9a-f]{64})\b/i.exec(body.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Dump + `.sha256` sidecar. Missing objects are not an error. */
export async function deleteBackupObject(client: S3Client, bucket: string, key: string): Promise<void> {
  for (const target of [key, sidecarKey(key)]) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: target }));
  }
}

/** Abort every in-progress multipart for this key (stale reclaim, cancel). */
export async function abortMultipartUploads(client: S3Client, bucket: string, key: string): Promise<number> {
  const listed = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }));
  let aborted = 0;
  for (const upload of listed.Uploads ?? []) {
    if (upload.Key !== key || !upload.UploadId) continue;
    await client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: upload.UploadId }),
    );
    aborted += 1;
  }
  return aborted;
}

export function presignDownload(client: S3Client, bucket: string, key: string): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${key.split('/').pop()}"`,
    }),
    { expiresIn: PRESIGNED_DOWNLOAD_SECONDS },
  );
}

export async function openBackupObjectStream(
  client: S3Client,
  bucket: string,
  key: string,
  abortSignal?: AbortSignal,
): Promise<Readable> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal });
  const body = response.Body as Readable | undefined;
  if (!body || typeof (body as any).pipe !== 'function') {
    throw new Error('S3 returned no readable body for the backup object');
  }
  return body;
}

/**
 * Exercises exactly the permissions a backup needs: HeadBucket, PutObject
 * (with SSE), HeadObject, DeleteObject on a throw-away marker under the
 * prefix. Reports each step so an IAM policy gap points at itself.
 */
export async function testBackupConnection(
  client: S3Client,
  config: DatabaseBackupConfig,
): Promise<BackupConnectionTest> {
  const started = Date.now();
  const bucket = config.s3.bucket!;
  const marker = `${config.s3.prefix ? `${config.s3.prefix}/` : ''}_connectivity/${randomUUID()}`;
  const checks: BackupConnectionCheck[] = [];
  const step = async (name: string, run: () => Promise<string | null>) => {
    try {
      checks.push({ name, ok: true, detail: await run() });
      return true;
    } catch (error: any) {
      checks.push({ name, ok: false, detail: String(error?.name ?? 'Error') + ': ' + String(error?.message ?? error) });
      return false;
    }
  };

  const bucketOk = await step('HeadBucket', async () => {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return bucket;
  });
  if (bucketOk) {
    const putOk = await step('PutObject (with encryption)', async () => {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: marker, Body: 'ok', ...encryptionParams(config) }),
      );
      return marker;
    });
    if (putOk) {
      await step('HeadObject', async () => {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: marker }));
        return head.ServerSideEncryption ? `encryption ${head.ServerSideEncryption}` : 'no encryption header';
      });
      await step('DeleteObject', async () => {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: marker }));
        return null;
      });
    }
    await step('ListMultipartUploads', async () => {
      await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: marker, MaxUploads: 1 }));
      return null;
    });
  }

  return { ok: checks.every((check) => check.ok), latencyMs: Date.now() - started, checks };
}
