import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openBackupObjectStream: vi.fn(async (_client: unknown, _bucket: string, _key: string) => Readable.from([Buffer.from('PGDMP...')])),
}));
vi.mock('./s3-objects', () => ({ openBackupObjectStream: mocks.openBackupObjectStream }));

import type { DatabaseBackupConfig } from './config';
import { verifyArchive } from './verify';

const config: DatabaseBackupConfig = {
  runnerEnabled: true, countryCode: 'IN',
  s3: { bucket: 'b', region: 'r', prefix: 'p', accessKeyId: 'k', secretAccessKey: 's', endpoint: null, forcePathStyle: false, sse: 'AES256', kmsKeyId: null },
  timeoutMinutes: 60, pgDumpPath: 'pg_dump', pgRestorePath: 'pg_restore', compression: 'zstd:3',
};

class FakeRestore extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(private readonly script: (child: FakeRestore) => void) {
    super();
    this.stdin.on('finish', () => this.script(this));
    // `pipeline` destroys stdin when the source fails: a real pg_restore then
    // reads end-of-input. Only script once.
    this.stdin.on('close', () => {
      if (this.exitCode === null && this.signalCode === null) this.script(this);
    });
  }
  kill() {
    this.signalCode = 'SIGTERM';
    this.emit('close', null, 'SIGTERM');
    return true;
  }
  finish(code: number) {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }
}

describe('verifyArchive', () => {
  it('counts table-of-contents entries when pg_restore accepts the archive', async () => {
    const child = new FakeRestore((self) => {
      self.stdout.write(';\n; Archive created at 2026-09-06\n;\n');
      self.stdout.write('1; 0 0 ENCODING - ENCODING\n2; 3079 16384 EXTENSION - pg_trgm\n');
      self.stdout.write('3; 1259 16385 TABLE public stores strapi'); // no trailing newline
      self.finish(0);
    });
    const result = await verifyArchive({ client: {} as any, config, bucket: 'b', key: 'k', childEnv: {}, spawnImpl: () => child as any });
    expect(result).toEqual({ ok: true, tocEntries: 3 });
  });

  it('reports pg_restore failures with the stderr tail', async () => {
    const child = new FakeRestore((self) => {
      self.stderr.write('pg_restore: error: input file does not appear to be a valid archive');
      self.finish(1);
    });
    const result = await verifyArchive({ client: {} as any, config, bucket: 'b', key: 'k', childEnv: {}, spawnImpl: () => child as any });
    expect(result).toEqual({
      ok: false,
      error: 'pg_restore --list failed (exit code 1): pg_restore: error: input file does not appear to be a valid archive',
    });
  });

  it('accepts pg_restore finishing before the archive stream ends', async () => {
    // A custom-format archive far larger than any pipe buffer; `--list` only
    // reads the head and exits, so the writer sees EPIPE.
    const chunk = Buffer.alloc(1 << 20, 1);
    mocks.openBackupObjectStream.mockResolvedValueOnce(
      Readable.from((function* () { for (let i = 0; i < 64; i += 1) yield chunk; })()),
    );
    const child = new FakeRestore(() => undefined);
    child.stdin.once('data', () => {
      child.stdout.write('1; 0 0 ENCODING - ENCODING\n2; 1259 16385 TABLE public stores strapi\n');
      child.finish(0);
      child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    });
    const result = await verifyArchive({ client: {} as any, config, bucket: 'archive-bucket', key: 'k', childEnv: {}, spawnImpl: () => child as any });
    expect(result).toEqual({ ok: true, tocEntries: 2 });
    expect(mocks.openBackupObjectStream).toHaveBeenCalledWith({}, 'archive-bucket', 'k', undefined);
  });

  it('reports a stream that breaks before the listing is complete', async () => {
    mocks.openBackupObjectStream.mockResolvedValueOnce(
      Readable.from((async function* () { yield Buffer.from('PGDMP'); throw new Error('S3 read reset'); })()),
    );
    const child = new FakeRestore((self) => {
      self.stderr.write('pg_restore: error: could not read from input file: end of file');
      self.finish(1);
    });
    const result = await verifyArchive({ client: {} as any, config, bucket: 'b', key: 'k', childEnv: {}, spawnImpl: () => child as any });
    expect(result).toEqual({
      ok: false,
      error: 'pg_restore --list failed (exit code 1): pg_restore: error: could not read from input file: end of file; archive stream: S3 read reset',
    });
  });

  it('treats an empty listing as a failure', async () => {
    const child = new FakeRestore((self) => self.finish(0));
    const result = await verifyArchive({ client: {} as any, config, bucket: 'b', key: 'k', childEnv: {}, spawnImpl: () => child as any });
    expect(result).toEqual({ ok: false, error: 'pg_restore --list produced an empty table of contents' });
  });
});
