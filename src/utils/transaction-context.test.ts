import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const directory = dirname(require.resolve('@strapi/database'));

for (const extension of ['js', 'mjs']) {
  describe(`installed Strapi transaction context (${extension})`, async () => {
    const { transactionCtx: ctx } = await import(/* @vite-ignore */ pathToFileURL(join(directory, `transaction-context.${extension}`)).href);
    const transaction = () => {
      let completed = false;
      return {
        commit: vi.fn(async () => { completed = true; }),
        rollback: vi.fn(async () => { completed = true; }),
        isCompleted: () => completed,
      };
    };

    it('shares active nesting, then isolates a delayed descendant and callback-started transaction', async () => {
      const outer = transaction();
      const effects: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let delayed!: Promise<void>;
      let fromCallback!: Promise<void>;
      await ctx.run(outer, async () => {
        ctx.onCommit(() => {
          effects.push('outer');
          const next = transaction();
          fromCallback = ctx.run(next, async () => {
            ctx.onCommit(() => effects.push('callback transaction'));
            await ctx.commit(next);
          });
        });
        await ctx.run(outer, async () => {
          ctx.onCommit(() => effects.push('nested'));
          delayed = (async () => {
            await gate;
            expect(ctx.get()).toBeUndefined();
            const next = transaction();
            await ctx.run(next, async () => {
              ctx.onCommit(() => effects.push('delayed'));
              await ctx.commit(next);
            });
          })();
        });
        expect(effects).toEqual([]);
        await ctx.commit(outer);
        await ctx.commit(outer);
        await ctx.rollback(outer);
      });
      await fromCallback;
      release();
      await delayed;
      expect(effects).toEqual(['outer', 'nested', 'callback transaction', 'delayed']);
      expect(outer.commit).toHaveBeenCalledTimes(1);
    });

    it('discards commit effects on rollback and never replays finalization', async () => {
      const trx = transaction();
      const commit = vi.fn();
      const rollback = vi.fn();
      await ctx.run(trx, async () => {
        ctx.onCommit(commit);
        ctx.onRollback(rollback);
        await ctx.rollback(trx);
        await ctx.rollback(trx);
        await ctx.commit(trx);
      });
      expect(commit).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledTimes(1);
    });

    it.each(['commit', 'rollback'])('clears queues even when a %s callback throws', async (method) => {
      const trx = transaction();
      const effect = vi.fn(() => { throw new Error('callback failure'); });
      await ctx.run(trx, async () => {
        ctx[method === 'commit' ? 'onCommit' : 'onRollback'](effect);
        await expect(ctx[method](trx)).rejects.toThrow('callback failure');
        await ctx.commit(trx);
        await ctx.rollback(trx);
        const next = transaction();
        await ctx.run(next, () => ctx.commit(next));
      });
      expect(effect).toHaveBeenCalledTimes(1);
    });

    it('isolates independent concurrent transactions and different nested transactors', async () => {
      const effects: number[] = [];
      const run = async (id: number) => {
        const trx = transaction();
        await ctx.run(trx, async () => {
          ctx.onCommit(() => effects.push(id));
          await Promise.resolve();
          expect(ctx.get()).toBe(trx);
          await ctx.commit(trx);
        });
      };
      await Promise.all([run(1), run(2)]);
      const outer = transaction();
      await ctx.run(outer, async () => {
        ctx.onCommit(() => effects.push(4));
        await run(3);
        expect(effects).toEqual([1, 2, 3]);
        await ctx.commit(outer);
      });
      expect(effects).toEqual([1, 2, 3, 4]);
    });

    it.each(['commit', 'rollback'])('discards queues when the transactor %s rejects', async (method) => {
      const trx = transaction();
      trx[method].mockRejectedValueOnce(new Error('database failure'));
      const effect = vi.fn();
      await ctx.run(trx, async () => {
        ctx.onCommit(effect);
        await expect(ctx[method](trx)).rejects.toThrow('database failure');
        await ctx.commit(trx);
        await ctx.rollback(trx);
      });
      expect(effect).not.toHaveBeenCalled();
    });
  });
}
