import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, it } from 'vitest';
import { runInBackground } from './execution-context';
import { isTranslationWrite, runWithTranslationWriteFlag } from '../translation/write-flag';

it('drops request and translation context on wake while localized writes explicitly opt in', async () => {
  const request = new AsyncLocalStorage<string>();
  await request.run('editor', () => runWithTranslationWriteFlag(async () => {
    expect(isTranslationWrite()).toBe(true);
    await runInBackground(async () => {
      expect(request.getStore()).toBeUndefined();
      expect(isTranslationWrite()).toBe(false);
      await runWithTranslationWriteFlag(async () => {
        expect(isTranslationWrite()).toBe(true);
      });
      expect(isTranslationWrite()).toBe(false);
    });
    expect(request.getStore()).toBe('editor');
    expect(isTranslationWrite()).toBe(true);
  }));
});

it('does not inherit an active Strapi transaction when a worker is woken', async () => {
  const require = createRequire(import.meta.url);
  const { transactionCtx } = require(join(dirname(require.resolve('@strapi/database')), 'transaction-context.js'));
  const trx = { isCompleted: () => false };
  await transactionCtx.run(trx, async () => {
    expect(transactionCtx.get()).toBe(trx);
    await runInBackground(async () => {
      expect(transactionCtx.get()).toBeUndefined();
      await Promise.resolve();
      expect(transactionCtx.get()).toBeUndefined();
    });
    expect(transactionCtx.get()).toBe(trx);
  });
});
