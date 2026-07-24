import { describe, expect, it, vi } from 'vitest';
import { runContentTransaction } from './transaction';

function transactionHarness(options: { failInsert?: boolean } = {}) {
  const rows: any[] = [];
  let commitCallback: (() => void) | null = null;
  const trx = vi.fn(() => ({
    insert: (row: any) => {
      rows.push(row);
      return {
        returning: async () => {
          if (options.failInsert) throw new Error('outbox insert failed');
          return [{ id: 1, event_key: row.event_key }];
        },
      };
    },
  }));
  const strapi = {
    db: {
      transaction: async (callback: any) => {
        const result = await callback({
          trx,
          onCommit: (fn: () => void) => {
            commitCallback = fn;
          },
        });
        commitCallback?.();
        return result;
      },
    },
  } as any;
  return { strapi, rows };
}

describe('runContentTransaction', () => {
  it('commits the content result and outbox event together, then wakes delivery', async () => {
    const { strapi, rows } = transactionHarness();
    const afterCommit = vi.fn();
    const result = await runContentTransaction(
      strapi,
      async () => ({ documentId: 'coupon-1' }),
      async () => ({
        eventKey: 'event-1',
        reason: 'coupon update',
        payload: { paths: ['/amazon/'] },
      }),
      afterCommit,
    );

    expect(result).toEqual({ documentId: 'coupon-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_key: 'event-1',
      status: 'pending',
    });
    expect(afterCommit).toHaveBeenCalledWith({
      id: '1',
      eventKey: 'event-1',
      reason: 'coupon update',
      payload: { paths: ['/amazon/'] },
    });
  });

  it('rejects the content transaction when durable invalidation cannot be inserted', async () => {
    const { strapi } = transactionHarness({ failInsert: true });
    const afterCommit = vi.fn();
    await expect(
      runContentTransaction(
        strapi,
        async () => ({ documentId: 'coupon-1' }),
        async () => ({
          reason: 'coupon update',
          payload: { paths: ['/amazon/'] },
        }),
        afterCommit,
      ),
    ).rejects.toThrow('outbox insert failed');
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('does not create an outbox row for an unrelated content operation', async () => {
    const { strapi, rows } = transactionHarness();
    await runContentTransaction(
      strapi,
      async () => 'ok',
      async () => null,
      vi.fn(),
    );
    expect(rows).toEqual([]);
  });
});
