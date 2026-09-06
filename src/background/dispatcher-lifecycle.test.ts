import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { IsrOutboxDispatcher } from '../isr-outbox/dispatcher';
import { TranslationDispatcher } from '../translation/outbox/dispatcher';
import { isTranslationWrite, runWithTranslationWriteFlag } from '../translation/write-flag';

afterEach(() => vi.useRealTimers());

for (const kind of ['isr', 'translation']) {
  it(`${kind} wakes in clean context, starts once, and cannot reschedule after stop`, async () => {
    vi.useFakeTimers();
    const strapi = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
    const config = { pollMs: 100, leaseMs: 100, maxBackoffMs: 100 } as any;
    const dispatcher: any = kind === 'isr'
      ? new IsrOutboxDispatcher(strapi, config)
      : new TranslationDispatcher(strapi, config, config, { name: 'test' } as any);
    const request = new AsyncLocalStorage<string>();
    let release!: () => void;
    const cycle = vi.spyOn(dispatcher, 'runCycle').mockImplementation(async () => {
      expect(request.getStore()).toBeUndefined();
      expect(isTranslationWrite()).toBe(false);
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await request.run('editor', () => runWithTranslationWriteFlag(async () => {
      dispatcher.start();
      dispatcher.start();
      dispatcher.wake();
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(strapi.log.info).toHaveBeenCalledTimes(1);
    const stop = dispatcher.stop();
    dispatcher.start();
    dispatcher.wake();
    release();
    await stop;
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
}
