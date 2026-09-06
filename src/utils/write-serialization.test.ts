import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireWriteSerializationLock } from './write-serialization';

const makeStrapi = (client: string) => ({ db: { connection: {
  client: { config: { client } }, transaction: vi.fn(),
} } }) as any;

afterEach(() => vi.unstubAllEnvs());

describe('content-transaction serialization', () => {
  it('uses the caller transaction without reserving another connection', async () => {
    const strapi = makeStrapi('pg');
    const trx = { raw: vi.fn().mockResolvedValue({ rows: [{ lock_timeout: '0' }] }) };
    await acquireWriteSerializationLock(strapi, 'identity', trx);
    expect(trx.raw).toHaveBeenCalledWith("SELECT set_config('lock_timeout', ?, true)", ['8000ms']);
    expect(trx.raw).toHaveBeenLastCalledWith("SELECT set_config('lock_timeout', ?, true)", ['0']);
    expect(trx.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      ['cguru:document-write', 'identity'],
    );
    expect(strapi.db.connection.transaction).not.toHaveBeenCalled();
  });
  it('rejects a missing content transaction on PostgreSQL', async () => {
    await expect(acquireWriteSerializationLock(makeStrapi('pg'), 'redirect', null))
      .rejects.toThrow('content transaction');
  });
  it('propagates lock failure so the content transaction rolls back', async () => {
    const trx = { raw: vi.fn().mockRejectedValue(new Error('lock timeout')) };
    await expect(acquireWriteSerializationLock(makeStrapi('pg'), 'job', trx))
      .rejects.toThrow('lock timeout');
  });
  it('does not issue PostgreSQL SQL on SQLite', async () => {
    const trx = { raw: vi.fn() };
    await acquireWriteSerializationLock(makeStrapi('better-sqlite3'), 'identity', trx);
    expect(trx.raw).not.toHaveBeenCalled();
  });
  it('honors a bounded operator timeout and reports lock contention without further SQL', async () => {
    vi.stubEnv('WRITE_SERIALIZATION_TIMEOUT_MS', '12000');
    const trx = { raw: vi.fn().mockResolvedValueOnce({ rows: [{ lock_timeout: '3s' }] })
      .mockResolvedValueOnce({}).mockRejectedValueOnce({ code: '55P03' }) };
    await expect(acquireWriteSerializationLock(makeStrapi('pg'), 'identity', trx)).rejects.toThrow('please retry');
    expect(trx.raw).toHaveBeenCalledWith("SELECT set_config('lock_timeout', ?, true)", ['12000ms']);
    expect(trx.raw).toHaveBeenCalledTimes(3);
  });

});
