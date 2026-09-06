import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  uploads: [] as any[],
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class FakeUpload {
    params: any;
    aborted = false;
    private listeners: Array<(progress: any) => void> = [];
    constructor(options: any) {
      this.params = options.params;
      mocks.uploads.push(this);
    }
    on(_event: string, listener: (progress: any) => void) {
      this.listeners.push(listener);
    }
    async abort() {
      this.aborted = true;
    }
    done() {
      return new Promise((resolve, reject) => {
        let loaded = 0;
        this.params.Body.on('data', (chunk: Buffer) => {
          loaded += chunk.length;
          for (const listener of this.listeners) listener({ loaded });
        });
        this.params.Body.on('end', () => resolve({ ETag: '"etag-1"' }));
        this.params.Body.on('error', (error: Error) => {
          void this.abort();
          reject(error);
        });
      });
    }
  },
}));

import { ArchiveStream } from './pg-dump';
import { uploadArchive } from './s3-upload';
import type { DatabaseBackupConfig } from './config';

const config: DatabaseBackupConfig = {
  runnerEnabled: true, countryCode: 'IN',
  s3: { bucket: 'backups', region: 'ap-south-1', prefix: 'db', accessKeyId: 'k', secretAccessKey: 's', endpoint: null, forcePathStyle: false, sse: 'AES256', kmsKeyId: null },
  timeoutMinutes: 60, pgDumpPath: 'pg_dump', pgRestorePath: 'pg_restore', compression: 'zstd:3',
};

function fakeClient(contentLength: number | ((bytes: number) => number)) {
  const sent: any[] = [];
  return {
    sent,
    send: vi.fn(async (command: any) => {
      sent.push(command);
      if (command.constructor.name === 'HeadObjectCommand') {
        const length = typeof contentLength === 'function' ? contentLength(0) : contentLength;
        return { ContentLength: length, ETag: '"etag-head"' };
      }
      return {};
    }),
  };
}

const payload = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(1000, 1)]);

function archiveFrom(chunks: Buffer[], exit: { code: number | null; signal?: NodeJS.Signals | null }) {
  const archive = new ArchiveStream(
    Promise.resolve({ code: exit.code, signal: exit.signal ?? null, spawnError: null, stderrTail: 'boom' }),
    'pg_dump',
  );
  Readable.from(chunks).pipe(archive);
  return archive;
}

describe('uploadArchive', () => {
  it('streams, verifies the stored length, and writes the sha256 sidecar', async () => {
    mocks.uploads.length = 0;
    const client = fakeClient(payload.length);
    const archive = archiveFrom([payload], { code: 0 });
    const progress: number[] = [];
    const result = await uploadArchive({
      client: client as any, config, key: 'db/IN/x.dump', archive, metadata: { 'run-id': 'r1' }, onProgress: (n) => progress.push(n),
    });
    expect(result).toEqual({ bytes: payload.length, sha256: archive.sha256, etag: '"etag-1"' });
    expect(progress.at(-1)).toBe(payload.length);
    expect(mocks.uploads[0].params).toMatchObject({
      Bucket: 'backups', Key: 'db/IN/x.dump', ServerSideEncryption: 'AES256', Metadata: { 'run-id': 'r1' },
    });
    const sidecar = client.sent.find((command) => command.constructor.name === 'PutObjectCommand');
    expect(sidecar.input).toMatchObject({ Key: 'db/IN/x.dump.sha256', ServerSideEncryption: 'AES256' });
    expect(String(sidecar.input.Body)).toBe(`${archive.sha256}  x.dump\n`);
  });

  it('rejects and aborts the multipart when pg_dump exits non-zero', async () => {
    mocks.uploads.length = 0;
    const client = fakeClient(payload.length);
    const archive = archiveFrom([payload], { code: 1 });
    await expect(uploadArchive({ client: client as any, config, key: 'k', archive, metadata: {} }))
      .rejects.toThrow('pg_dump exited with code 1');
    expect(mocks.uploads[0].aborted).toBe(true);
    expect(client.sent.some((command) => command.constructor.name === 'PutObjectCommand')).toBe(false);
  });

  it('fails when the stored object is shorter than what was streamed', async () => {
    mocks.uploads.length = 0;
    const client = fakeClient(payload.length - 1);
    const archive = archiveFrom([payload], { code: 0 });
    await expect(uploadArchive({ client: client as any, config, key: 'k', archive, metadata: {} }))
      .rejects.toThrow(`uploaded object size ${payload.length - 1} does not match streamed ${payload.length} bytes`);
  });

  it('aborts on cancellation', async () => {
    mocks.uploads.length = 0;
    const client = fakeClient(payload.length);
    const controller = new AbortController();
    const archive = new ArchiveStream(new Promise(() => undefined), 'pg_dump');
    archive.write(Buffer.from('PGDMP'));
    const pending = uploadArchive({ client: client as any, config, key: 'k', archive, metadata: {}, abortSignal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('backup cancelled');
    expect(mocks.uploads[0].aborted).toBe(true);
  });
});
