import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ArchiveStream, parseToolVersion, spawnProcess, type ExitInfo, type SpawnFn } from './pg-dump';

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const exit = (partial: Partial<ExitInfo>): ExitInfo => ({ code: 0, signal: null, spawnError: null, stderrTail: '', ...partial });

describe('ArchiveStream', () => {
  it('passes a valid archive through, counting bytes and hashing', async () => {
    const payload = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(3000, 7)]);
    const archive = new ArchiveStream(Promise.resolve(exit({})), 'pg_dump');
    Readable.from([payload.subarray(0, 3), payload.subarray(3)]).pipe(archive);
    const output = await collect(archive);
    expect(output.equals(payload)).toBe(true);
    expect(archive.bytes).toBe(payload.length);
    expect(archive.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(archive.sha256).toBe(archive.sha256);
  });

  it('refuses to end cleanly when the producer exited non-zero', async () => {
    const archive = new ArchiveStream(Promise.resolve(exit({ code: 1, stderrTail: 'pg_dump: error: connection refused' })), 'pg_dump');
    Readable.from([Buffer.from('PGDMP partial')]).pipe(archive);
    await expect(collect(archive)).rejects.toThrow('pg_dump exited with code 1: pg_dump: error: connection refused');
  });

  it('reports a kill signal and a spawn failure', async () => {
    const killed = new ArchiveStream(Promise.resolve(exit({ code: null, signal: 'SIGTERM' })), 'pg_dump');
    Readable.from([Buffer.from('PGDMPxx')]).pipe(killed);
    await expect(collect(killed)).rejects.toThrow('was killed by SIGTERM');

    const missing = new ArchiveStream(Promise.resolve(exit({ code: null, spawnError: 'spawn pg_dump ENOENT' })), 'pg_dump');
    Readable.from([]).pipe(missing);
    await expect(collect(missing)).rejects.toThrow('could not start: spawn pg_dump ENOENT');
  });

  it('rejects output that is not a custom-format archive, or no output at all', async () => {
    const wrong = new ArchiveStream(Promise.resolve(exit({})), 'pg_dump');
    Readable.from([Buffer.from('-- PostgreSQL database dump (plain text)')]).pipe(wrong);
    await expect(collect(wrong)).rejects.toThrow('not a PostgreSQL custom-format archive');

    const empty = new ArchiveStream(Promise.resolve(exit({})), 'pg_dump');
    Readable.from([]).pipe(empty);
    await expect(collect(empty)).rejects.toThrow('produced no archive');
  });
});

describe('parseToolVersion', () => {
  it('reads the major and minor from pg_dump --version', () => {
    expect(parseToolVersion('pg_dump (PostgreSQL) 18.6\n')).toEqual({ version: '18.6', major: 18 });
    expect(parseToolVersion('pg_restore (PostgreSQL) 16.15 (Debian)')).toEqual({ version: '16.15', major: 16 });
    expect(parseToolVersion('pg_dump (PostgreSQL) 18beta1')).toEqual({ version: '18', major: 18 });
    expect(parseToolVersion('command not found')).toBeNull();
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: string[] = [];
  kill(signal: NodeJS.Signals) {
    this.killed.push(signal);
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, signal);
    return true;
  }
}

describe('spawnProcess', () => {
  it('captures a redacted stderr tail and the exit code', async () => {
    const child = new FakeChild();
    const spawnImpl: SpawnFn = () => child as any;
    const spawned = spawnProcess('pg_dump', ['--x'], { PATH: '/bin' }, ['hunter2'], { spawnImpl });
    child.stderr.write('pg_dump: error: password hunter2 rejected\n');
    child.stderr.end();
    child.stdout.end();
    child.exitCode = 2;
    child.emit('close', 2, null);
    expect(await spawned.exited).toEqual({ code: 2, signal: null, spawnError: null, stderrTail: 'pg_dump: error: password *** rejected' });
  });

  it('kills with SIGTERM once and settles', async () => {
    const child = new FakeChild();
    const spawned = spawnProcess('pg_dump', [], {}, [], { spawnImpl: () => child as any });
    spawned.kill();
    spawned.kill();
    expect(child.killed).toEqual(['SIGTERM']);
    expect((await spawned.exited).signal).toBe('SIGTERM');
  });

  it('settles with a spawn error when the binary is missing', async () => {
    const child = new FakeChild();
    const spawned = spawnProcess('nope', [], {}, [], { spawnImpl: () => child as any });
    child.emit('error', new Error('spawn nope ENOENT'));
    expect((await spawned.exited).spawnError).toBe('spawn nope ENOENT');
  });
});
