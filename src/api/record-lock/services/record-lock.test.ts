import { beforeEach, describe, expect, it, vi } from 'vitest';

import createRecordLockService, {
  LOCK_TTL_MS,
  displayName,
  lockKey,
} from './record-lock';

type Row = {
  id: number;
  key: string;
  model: string;
  entryDocumentId: string;
  adminUserId: number;
  leaseId?: string;
  holderName: string;
  expiresAt: string;
};

type CancellationRow = {
  id: number;
  leaseId: string;
  expiresAt: string;
};

/**
 * In-memory stand-in for strapi.db.query('api::record-lock.record-lock')
 * covering exactly the operations the service uses: findOne/create/update by
 * id+holder guard/deleteMany, plus the UNIQUE(key) insert constraint.
 */
function createHarness(
  seed: Row[] = [],
  { kind = 'collectionType' }: { kind?: string } = {},
) {
  let rows: Row[] = [...seed];
  let cancellations: CancellationRow[] = [];
  let nextId = seed.reduce((max, row) => Math.max(max, row.id), 0) + 1;

  const matches = (row: Row, where: any): boolean =>
    Object.entries(where).every(([field, cond]) => {
      if (cond !== null && typeof cond === 'object' && '$lt' in (cond as any)) {
        return (row as any)[field] < (cond as any).$lt;
      }
      return (row as any)[field] === cond;
    });

  const query = {
    findOne: vi.fn(
      async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      if (rows.some((row) => row.key === data.key)) {
        throw Object.assign(new Error('unique violation'), { code: '23505' });
      }
      const row = { id: nextId++, ...data } as Row;
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.find((candidate) => matches(candidate, where));
      if (!row) return null;
      Object.assign(row, data);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = rows.length;
      rows = rows.filter((row) => !matches(row, where));
      return { count: before - rows.length };
    }),
  };

  const cancellationQuery = {
    findOne: vi.fn(
      async ({ where }: any) =>
        cancellations.find((row) => matches(row as Row, where)) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      if (cancellations.some((row) => row.leaseId === data.leaseId)) {
        throw Object.assign(new Error('unique violation'), { code: '23505' });
      }
      const row = { id: nextId++, ...data } as CancellationRow;
      cancellations.push(row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = cancellations.length;
      cancellations = cancellations.filter(
        (row) => !matches(row as Row, where),
      );
      return { count: before - cancellations.length };
    }),
  };

  const strapi = {
    db: {
      query: (uid: string) =>
        uid.includes('record-lock-cancellation') ? cancellationQuery : query,
    },
    getModel: vi.fn(() => ({ kind })),
  } as any;
  return {
    service: createRecordLockService({ strapi }),
    query,
    cancellationQuery,
    rows: () => rows,
    cancellations: () => cancellations,
  };
}

const MODEL = 'api::coupon.coupon';
const DOC = 'doc-1';
const alice = { id: 1, firstname: 'Alice', lastname: 'Ops', email: 'a@x.com' };
const bob = { id: 2, firstname: 'Bob', lastname: null, email: 'b@x.com' };
const ALICE_LEASE = 'alice-tab-a';
const ALICE_OTHER_LEASE = 'alice-tab-b';
const BOB_LEASE = 'bob-tab-a';

const activeRow = (user: typeof alice, msFromNow = LOCK_TTL_MS): Row => ({
  id: 99,
  key: lockKey(MODEL, DOC),
  model: MODEL,
  entryDocumentId: DOC,
  adminUserId: user.id,
  leaseId: user.id === alice.id ? ALICE_LEASE : BOB_LEASE,
  holderName: displayName(user),
  expiresAt: new Date(Date.now() + msFromNow).toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-03T10:00:00Z'));
});

describe('record-lock service', () => {
  it('grants a free entry and stores the holder snapshot', async () => {
    const { service, rows } = createHarness();
    const result = await service.acquire(MODEL, DOC, ALICE_LEASE, alice);
    expect(result).toMatchObject({ acquired: true });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      key: `${MODEL}:${DOC}`,
      adminUserId: 1,
      leaseId: ALICE_LEASE,
      holderName: 'Alice Ops',
    });
  });

  it('refuses a second admin while the lock is active, naming the holder', async () => {
    const { service } = createHarness([activeRow(alice)]);
    const result = await service.acquire(MODEL, DOC, BOB_LEASE, bob);
    expect(result).toEqual({
      acquired: false,
      self: false,
      holder: expect.objectContaining({
        adminUserId: 1,
        holderName: 'Alice Ops',
      }),
    });
  });

  it('lets the SAME admin explicitly take over their own orphaned lease, never another admin’s', async () => {
    const { service, rows } = createHarness([activeRow(alice)]);

    // Bob cannot steal Alice's lock even with takeover.
    const bobAttempt = await service.acquire(MODEL, DOC, BOB_LEASE, bob, {
      takeover: true,
    });
    expect(bobAttempt).toMatchObject({ acquired: false, self: false });
    expect(rows()[0].leaseId).toBe(ALICE_LEASE);

    // Alice's new session (post-F5) IS allowed to take her own lease over.
    const aliceAttempt = await service.acquire(
      MODEL,
      DOC,
      ALICE_OTHER_LEASE,
      alice,
      { takeover: true },
    );
    expect(aliceAttempt).toMatchObject({ acquired: true });
    expect(rows()[0].leaseId).toBe(ALICE_OTHER_LEASE);
  });

  it('marks a same-admin block as self so the panel can offer takeover', async () => {
    const { service } = createHarness([activeRow(alice)]);
    const result = await service.acquire(MODEL, DOC, ALICE_OTHER_LEASE, alice);
    expect(result).toMatchObject({ acquired: false, self: true });
  });

  it('treats a heartbeat from the holder as a refresh, not a conflict', async () => {
    const { service, rows } = createHarness([activeRow(alice, 10_000)]);
    const result = await service.acquire(MODEL, DOC, ALICE_LEASE, alice);
    expect(result).toMatchObject({ acquired: true });
    expect(new Date(rows()[0].expiresAt).getTime()).toBe(
      Date.now() + LOCK_TTL_MS,
    );
  });

  it('lets another admin take over once the lock has expired', async () => {
    const { service, rows } = createHarness([activeRow(alice, -1_000)]);
    const result = await service.acquire(MODEL, DOC, BOB_LEASE, bob);
    expect(result).toMatchObject({ acquired: true });
    // The expired row was swept, so takeover arrives as a fresh insert.
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ adminUserId: 2, holderName: 'Bob' });
  });

  it('reports the winner when losing the insert race on a free entry', async () => {
    const { service, query } = createHarness();
    // Simulate Bob inserting between Alice's read and write: first findOne
    // sees nothing, create then hits the unique constraint, and the re-read
    // finds Bob's row.
    query.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activeRow(bob) as any);
    query.create.mockRejectedValueOnce(
      Object.assign(new Error('unique violation'), { code: '23505' }),
    );
    const result = await service.acquire(MODEL, DOC, ALICE_LEASE, alice);
    expect(result).toMatchObject({
      acquired: false,
      holder: expect.objectContaining({ adminUserId: 2 }),
    });
  });

  it('release removes only the caller’s own lock', async () => {
    const { service, rows, cancellations } = createHarness([
      activeRow(alice),
    ]);
    await service.release(MODEL, DOC, BOB_LEASE, bob);
    expect(rows()).toHaveLength(1);
    expect(await service.release(MODEL, DOC, ALICE_LEASE, alice)).toBe(true);
    expect(rows()).toHaveLength(0);
    expect(cancellations().map((row) => row.leaseId)).toEqual([
      BOB_LEASE,
      ALICE_LEASE,
    ]);
    expect(await service.activeHolder(MODEL, DOC)).toBeNull();
  });

  it("does not let a duplicate tab refresh or release the owner's lease", async () => {
    const { service, rows } = createHarness([activeRow(alice)]);

    const result = await service.acquire(MODEL, DOC, ALICE_OTHER_LEASE, alice);
    expect(result).toMatchObject({
      acquired: false,
      holder: { adminUserId: alice.id },
    });

    expect(await service.release(MODEL, DOC, ALICE_OTHER_LEASE, alice)).toBe(
      false,
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0].leaseId).toBe(ALICE_LEASE);
  });

  it('fences an acquire that reaches the server after its release', async () => {
    const { service, rows, cancellations } = createHarness();

    expect(await service.release(MODEL, DOC, ALICE_LEASE, alice)).toBe(false);
    expect(cancellations()[0].leaseId).toBe(ALICE_LEASE);
    await expect(
      service.acquire(MODEL, DOC, ALICE_LEASE, alice),
    ).resolves.toEqual({ acquired: false, cancelled: true });
    expect(await service.activeHolder(MODEL, DOC)).toBeNull();
  });

  it('removes a lock when cancellation lands during its acquire', async () => {
    const { service, rows, cancellationQuery } = createHarness();
    cancellationQuery.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        leaseId: ALICE_LEASE,
        expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
      } as any);

    await expect(
      service.acquire(MODEL, DOC, ALICE_LEASE, alice),
    ).resolves.toEqual({ acquired: false, cancelled: true });
    expect(rows()).toHaveLength(0);
  });

  it('allows a different tab to acquire after another lease is cancelled', async () => {
    const { service, rows } = createHarness();
    await service.release(MODEL, DOC, ALICE_LEASE, alice);

    await expect(
      service.acquire(MODEL, DOC, ALICE_OTHER_LEASE, alice),
    ).resolves.toMatchObject({ acquired: true });
    expect(rows()[0]).toMatchObject({
      leaseId: ALICE_OTHER_LEASE,
    });
  });

  it('fences a blocked tab even if the current owner later releases', async () => {
    const { service, rows } = createHarness([activeRow(alice)]);

    // Bob closes while his acquire is unresolved. Alice still owns the row,
    // so the cancellation must live independently from that row.
    await service.release(MODEL, DOC, BOB_LEASE, bob);
    await service.release(MODEL, DOC, ALICE_LEASE, alice);
    expect(rows()).toHaveLength(0);
    await expect(
      service.acquire(MODEL, DOC, BOB_LEASE, bob),
    ).resolves.toEqual({ acquired: false, cancelled: true });
  });

  it('activeHolder ignores expired locks', async () => {
    const { service } = createHarness([activeRow(alice, -1)]);
    expect(await service.activeHolder(MODEL, DOC)).toBeNull();
  });

  it('activeHolder reports a live lock for the write guard', async () => {
    const { service } = createHarness([activeRow(alice)]);
    expect(await service.activeHolder(MODEL, DOC)).toMatchObject({
      adminUserId: 1,
      leaseId: ALICE_LEASE,
      holderName: 'Alice Ops',
    });
  });

  it('normalizes single types to the shared pseudo id whatever documentId the caller passes', async () => {
    const { service, rows } = createHarness([], { kind: 'singleType' });
    await service.acquire(MODEL, 'real-doc-id', ALICE_LEASE, alice);
    expect(rows()[0].key).toBe(`${MODEL}:single`);
    // A second admin using a DIFFERENT documentId still collides on the same
    // single-type lock — the two ids name the same single document.
    const result = await service.acquire(
      MODEL,
      'another-doc-id',
      BOB_LEASE,
      bob,
    );
    expect(result).toMatchObject({ acquired: false });
    expect(await service.activeHolder(MODEL, 'yet-another-id')).toMatchObject({
      adminUserId: 1,
    });
    await service.release(MODEL, 'whatever', ALICE_LEASE, alice);
    expect(await service.activeHolder(MODEL, 'whatever')).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('locks single types with documentId omitted entirely — the service owns the pseudo id', async () => {
    const { service, rows } = createHarness([], { kind: 'singleType' });
    const result = await service.acquire(MODEL, undefined, ALICE_LEASE, alice);
    expect(result).toMatchObject({ acquired: true });
    expect(rows()[0].key).toBe(`${MODEL}:single`);
    expect(await service.activeHolder(MODEL, undefined)).toMatchObject({
      adminUserId: 1,
    });
    expect(await service.release(MODEL, undefined, ALICE_LEASE, alice)).toBe(
      true,
    );
  });

  it('rejects a collection-type acquire without a documentId', async () => {
    const { service } = createHarness();
    await expect(
      service.acquire(MODEL, undefined, ALICE_LEASE, alice),
    ).rejects.toThrow(/documentId is required/);
  });

  it('surfaces a non-unique create failure instead of retrying it as a race', async () => {
    const { service, query } = createHarness();
    query.create.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      service.acquire(MODEL, DOC, ALICE_LEASE, alice),
    ).rejects.toThrow('connection reset');
  });

  it('gives up with an error after persistently losing the guarded update', async () => {
    const { service, query } = createHarness([activeRow(alice, -1_000)]);
    // Every guarded takeover of the expired row "loses": update matches
    // nothing, and the re-read keeps showing the same expired row.
    query.findOne.mockResolvedValue(activeRow(alice, -1_000) as any);
    query.update.mockResolvedValue(null as any);
    await expect(
      service.acquire(MODEL, DOC, BOB_LEASE, bob),
    ).rejects.toThrow(/gave up acquiring/);
  });
});

describe('displayName', () => {
  it('prefers full name, then username/email, then the id', () => {
    expect(displayName(alice)).toBe('Alice Ops');
    expect(displayName({ id: 3, email: 'c@x.com' })).toBe('c@x.com');
    expect(displayName({ id: 4 })).toBe('Admin #4');
  });
});
