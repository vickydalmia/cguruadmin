import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ construct: vi.fn(), start: vi.fn(), stop: vi.fn(async () => {}) }));
vi.mock('./config', () => ({ readIsrOutboxConfig: () => ({ enabled: true, gatewayUrl: 'http://test', adminSecret: 'test-secret-long-enough' }) }));
vi.mock('./dispatcher', () => ({ IsrOutboxDispatcher: class {
  constructor() { mocks.construct(); }
  start = mocks.start;
  stop = mocks.stop;
} }));
import { startIsrOutbox, stopIsrOutbox } from './runtime';

afterEach(async () => { await stopIsrOutbox(); });

it('starts once and defers replacement until the previous instance stops', async () => {
  startIsrOutbox({} as any);
  startIsrOutbox({} as any);
  expect(mocks.construct).toHaveBeenCalledTimes(1);
  let release!: () => void;
  mocks.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const stop = stopIsrOutbox();
  startIsrOutbox({} as any);
  startIsrOutbox({} as any);
  expect(mocks.construct).toHaveBeenCalledTimes(1);
  release();
  await stop;
  await Promise.resolve();
  expect(mocks.construct).toHaveBeenCalledTimes(2);
});

it('a later stop cancels a queued restart', async () => {
  startIsrOutbox({} as any);
  let release!: () => void;
  mocks.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const stop = stopIsrOutbox();
  startIsrOutbox({} as any);
  const stopAgain = stopIsrOutbox();
  release();
  await Promise.all([stop, stopAgain]);
  expect(mocks.construct).toHaveBeenCalledTimes(1);
});
