import { describe, expect, it, vi } from 'vitest';

import { headBackupObject, readSidecarSha256 } from './s3-objects';

function clientWith(handler: (command: any) => unknown) {
  return { send: vi.fn(async (command: any) => handler(command)) } as any;
}

describe('backup object inspection', () => {
  it('reports a committed object with its size and ETag, and a missing one as absent', async () => {
    const present = clientWith(() => ({ ContentLength: 4096, ETag: '"e1"' }));
    expect(await headBackupObject(present, 'b', 'k')).toEqual({ exists: true, sizeBytes: 4096, etag: '"e1"' });
    const missing = clientWith(() => { throw Object.assign(new Error('nope'), { name: 'NotFound' }); });
    expect(await headBackupObject(missing, 'b', 'k')).toEqual({ exists: false, sizeBytes: null, etag: null });
    const gone = clientWith(() => { throw Object.assign(new Error('nope'), { name: 'NoSuchKey' }); });
    expect(await headBackupObject(gone, 'b', 'k')).toEqual({ exists: false, sizeBytes: null, etag: null });
    const denied = clientWith(() => { throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }); });
    await expect(headBackupObject(denied, 'b', 'k')).rejects.toThrow('AccessDenied');
  });

  it('reads the checksum from the sidecar and treats a missing or malformed one as unknown', async () => {
    const hash = 'A'.repeat(64);
    const sidecar = clientWith((command) => {
      expect(command.input.Key).toBe('db/IN/x.dump.sha256');
      return { Body: { transformToString: async () => `${hash}  x.dump\n` } };
    });
    expect(await readSidecarSha256(sidecar, 'b', 'db/IN/x.dump')).toBe('a'.repeat(64));
    const missing = clientWith(() => { throw Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 404 } }); });
    expect(await readSidecarSha256(missing, 'b', 'db/IN/x.dump')).toBeNull();
    const malformed = clientWith(() => ({ Body: { transformToString: async () => 'not a checksum' } }));
    expect(await readSidecarSha256(malformed, 'b', 'db/IN/x.dump')).toBeNull();
  });
});
