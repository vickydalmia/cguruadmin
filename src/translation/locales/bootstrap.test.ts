import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureContentLocales: vi.fn(),
  primeEnabledContentLocales: vi.fn(),
}));
vi.mock('../ensure-locales', () => ({ ensureContentLocales: mocks.ensureContentLocales }));
vi.mock('./registry', () => ({ primeEnabledContentLocales: mocks.primeEnabledContentLocales }));

import { bootstrapContentLocales, stopContentLocaleBootstrapRetry } from './bootstrap';

const strapi = () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }) as any;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.ensureContentLocales.mockReset();
  mocks.primeEnabledContentLocales.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  stopContentLocaleBootstrapRetry();
  vi.useRealTimers();
});

it('starts the dependents once when the bootstrap succeeds immediately', async () => {
  mocks.ensureContentLocales.mockResolvedValue(undefined);
  const onReady = vi.fn(async () => undefined);
  expect(await bootstrapContentLocales(strapi(), { onReady })).toBe(true);
  expect(onReady).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(onReady).toHaveBeenCalledTimes(1);
});

it('retries with doubling backoff, capped, and starts the dependents exactly once on recovery', async () => {
  mocks.ensureContentLocales
    .mockRejectedValueOnce(new Error('db down'))
    .mockRejectedValueOnce(new Error('db down'))
    .mockRejectedValueOnce(new Error('db down'))
    .mockResolvedValue(undefined);
  const onReady = vi.fn(async () => undefined);
  const app = strapi();
  expect(await bootstrapContentLocales(app, { onReady })).toBe(false);
  expect(app.log.error).toHaveBeenCalledTimes(1);
  expect(onReady).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(60_000); // attempt 2 fails → next in 120 s
  expect(mocks.ensureContentLocales).toHaveBeenCalledTimes(2);
  expect(app.log.warn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(119_000);
  expect(mocks.ensureContentLocales).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_000); // attempt 3 fails → next in 240 s
  expect(mocks.ensureContentLocales).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(240_000); // attempt 4 succeeds
  expect(mocks.ensureContentLocales).toHaveBeenCalledTimes(4);
  expect(mocks.primeEnabledContentLocales).toHaveBeenCalledTimes(1);
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(app.log.info).toHaveBeenCalledWith('[translation] content-locale bootstrap recovered');

  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(mocks.ensureContentLocales).toHaveBeenCalledTimes(4);
  expect(onReady).toHaveBeenCalledTimes(1);
});

it('caps the delay at ten minutes and stops retrying when asked', async () => {
  mocks.ensureContentLocales.mockRejectedValue(new Error('db down'));
  const app = strapi();
  await bootstrapContentLocales(app, { onReady: async () => undefined, initialRetryMs: 4 * 60_000 });
  await vi.advanceTimersByTimeAsync(4 * 60_000); // → next 8 min
  await vi.advanceTimersByTimeAsync(8 * 60_000); // → next capped at 10 min
  expect(app.log.warn.mock.calls.at(-1)?.[0]).toMatch(/retrying in 600s/);
  stopContentLocaleBootstrapRetry();
  const calls = mocks.ensureContentLocales.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(mocks.ensureContentLocales).toHaveBeenCalledTimes(calls);
});
