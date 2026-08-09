import { describe, expect, it, vi } from 'vitest';
import { acquireWriteSerializationLock } from './write-serialization';

function strapiWithKnex(client: string, trx: any, transactionError?: Error) {
  return {
    db: {
      connection: {
        client: { config: { client } },
        transaction: transactionError
          ? vi.fn(async () => {
              throw transactionError;
            })
          : vi.fn(async () => trx),
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;
}

describe('acquireWriteSerializationLock', () => {
  it('is a no-op (null) on non-Postgres dialects', async () => {
    const strapi = strapiWithKnex('better-sqlite3', {});
    await expect(
      acquireWriteSerializationLock(strapi, 'identity'),
    ).resolves.toBeNull();
    expect(strapi.db.connection.transaction).not.toHaveBeenCalled();
  });

  it('takes the advisory lock on a dedicated transaction and commits on release', async () => {
    const trx = {
      raw: vi.fn(async () => ({})),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };
    const strapi = strapiWithKnex('postgres', trx);

    const release = await acquireWriteSerializationLock(strapi, 'redirect');
    expect(release).toBeTypeOf('function');
    expect(trx.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      ['cguru:document-write', 'redirect'],
    );

    await release!();
    expect(trx.commit).toHaveBeenCalledTimes(1);
    expect(trx.rollback).not.toHaveBeenCalled();
  });

  it('proceeds unserialized (null + warn) when the lock cannot be taken, rolling back', async () => {
    const trx = {
      raw: vi.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          throw new Error('canceling statement due to lock timeout');
        }
        return {};
      }),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };
    const strapi = strapiWithKnex('pg', trx);

    await expect(
      acquireWriteSerializationLock(strapi, 'identity'),
    ).resolves.toBeNull();
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(strapi.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('proceeding unserialized'),
    );
  });

  it('proceeds unserialized when opening the lock transaction itself fails', async () => {
    const strapi = strapiWithKnex('pg', {}, new Error('pool exhausted'));
    await expect(
      acquireWriteSerializationLock(strapi, 'identity'),
    ).resolves.toBeNull();
    expect(strapi.log.warn).toHaveBeenCalled();
  });

  it('rejects the save on lock timeout when the domain fails closed', async () => {
    const trx = {
      raw: vi.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          throw new Error('canceling statement due to lock timeout');
        }
        return {};
      }),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };
    const strapi = strapiWithKnex('pg', trx);

    await expect(
      acquireWriteSerializationLock(strapi, 'affiliate', {
        onUnavailable: 'closed',
      }),
    ).rejects.toThrow(/still in progress.*try again/s);
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(strapi.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('fail-closed'),
    );
  });

  it('fail-closed still no-ops on non-Postgres (no lock exists to wait on)', async () => {
    const strapi = strapiWithKnex('better-sqlite3', {});
    await expect(
      acquireWriteSerializationLock(strapi, 'affiliate', {
        onUnavailable: 'closed',
      }),
    ).resolves.toBeNull();
  });

  it('takes EVERY domain of an array on ONE transaction, in order', async () => {
    const trx = {
      raw: vi.fn(async () => ({})),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };
    const strapi = strapiWithKnex('postgres', trx);

    const release = await acquireWriteSerializationLock(strapi, [
      'affiliate',
      'identity',
    ]);
    expect(release).toBeTypeOf('function');
    // One dedicated connection: a single transaction() call carrying both
    // advisory locks, sequentially, in the caller's fixed order.
    expect(strapi.db.connection.transaction).toHaveBeenCalledTimes(1);
    const lockCalls = trx.raw.mock.calls.filter(([sql]) =>
      String(sql).includes('pg_advisory_xact_lock'),
    );
    expect(lockCalls.map(([, params]) => params)).toEqual([
      ['cguru:document-write', 'affiliate'],
      ['cguru:document-write', 'identity'],
    ]);

    await release!();
    expect(trx.commit).toHaveBeenCalledTimes(1);
  });

  it('is all-or-nothing for an array: a later lock failing releases everything', async () => {
    const trx = {
      raw: vi.fn(async (sql: string, params?: unknown[]) => {
        if (
          String(sql).includes('pg_advisory_xact_lock') &&
          Array.isArray(params) &&
          params[1] === 'identity'
        ) {
          throw new Error('canceling statement due to lock timeout');
        }
        return {};
      }),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };
    const strapi = strapiWithKnex('pg', trx);

    await expect(
      acquireWriteSerializationLock(strapi, ['affiliate', 'identity'], {
        onUnavailable: 'closed',
      }),
    ).rejects.toThrow(/still in progress/);
    // The single rollback releases the already-acquired 'affiliate' lock too.
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(trx.commit).not.toHaveBeenCalled();
    // The label names the whole set.
    expect(strapi.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('affiliate+identity'),
    );
  });

  it('returns null for an empty domain array without opening a transaction', async () => {
    const strapi = strapiWithKnex('postgres', {});
    await expect(
      acquireWriteSerializationLock(strapi, []),
    ).resolves.toBeNull();
    expect(strapi.db.connection.transaction).not.toHaveBeenCalled();
  });
});
