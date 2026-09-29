import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import path from 'node:path';

import type { DatabaseBackupConfig } from './config';
import { UPLOAD_PART_SIZE_BYTES, UPLOAD_QUEUE_SIZE } from './constants';
import type { ArchiveStream } from './pg-dump';
import { encryptionParams, sidecarKey } from './s3-client';

/**
 * Streams the archive into S3 as a multipart upload. `Upload` buffers at most
 * `queueSize × partSize` bytes; when S3 is slower than `pg_dump` the pipe
 * fills and `pg_dump` simply blocks on write. Any error from the archive
 * (non-zero exit, bad magic) rejects `done()`, and `leavePartsOnError: false`
 * makes the SDK abort the multipart so no orphaned parts are billed.
 */

export type UploadResult = {
  bytes: number;
  sha256: string;
  etag: string | null;
};

export type UploadInput = {
  client: S3Client;
  config: DatabaseBackupConfig;
  key: string;
  archive: ArchiveStream;
  metadata: Record<string, string>;
  onProgress?: (loadedBytes: number) => void;
  /** Resolve to cancel: aborts the multipart and rejects `done()`. */
  abortSignal?: AbortSignal;
};

export async function uploadArchive(input: UploadInput): Promise<UploadResult> {
  const bucket = input.config.s3.bucket!;
  const upload = new Upload({
    client: input.client,
    params: {
      Bucket: bucket,
      Key: input.key,
      Body: input.archive,
      ContentType: 'application/octet-stream',
      Metadata: input.metadata,
      ...encryptionParams(input.config),
    },
    partSize: UPLOAD_PART_SIZE_BYTES,
    queueSize: UPLOAD_QUEUE_SIZE,
    leavePartsOnError: false,
  });

  if (input.onProgress) {
    upload.on('httpUploadProgress', (progress) => {
      if (typeof progress.loaded === 'number') input.onProgress!(progress.loaded);
    });
  }

  const onAbort = () => {
    void upload.abort().catch(() => undefined);
    input.archive.destroy(new Error('backup cancelled'));
  };
  input.abortSignal?.addEventListener('abort', onAbort, { once: true });

  let result: { ETag?: string } | undefined;
  try {
    result = (await upload.done()) as { ETag?: string };
  } finally {
    input.abortSignal?.removeEventListener('abort', onAbort);
  }

  const head = await input.client.send(new HeadObjectCommand({ Bucket: bucket, Key: input.key }), { abortSignal: input.abortSignal });
  if (typeof head.ContentLength !== 'number' || head.ContentLength !== input.archive.bytes) {
    throw new Error(
      `uploaded object size ${head.ContentLength ?? 'unknown'} does not match streamed ${input.archive.bytes} bytes`,
    );
  }

  const sha256 = input.archive.sha256;
  await input.client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: sidecarKey(input.key),
      Body: `${sha256}  ${path.posix.basename(input.key)}\n`,
      ContentType: 'text/plain',
      ...encryptionParams(input.config),
    }),
    { abortSignal: input.abortSignal },
  );

  return { bytes: input.archive.bytes, sha256, etag: result?.ETag ?? head.ETag ?? null };
}
