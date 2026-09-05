import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  locales: vi.fn(async () => [{ code: 'ar' }]),
  start: vi.fn(), stop: vi.fn(async () => {}),
  construct: vi.fn(),
}));
vi.mock('../locales/registry', () => ({ enabledContentLocales: mocks.locales }));
vi.mock('../config', () => ({ translationConfigFromEnv: () => ({ concurrency: 1 }) }));
vi.mock('./config', () => ({ readTranslationOutboxConfig: () => ({ enabled: true }) }));
vi.mock('../provider', () => ({ configureTranslationConcurrency: vi.fn() }));
vi.mock('./dispatcher', () => ({ TranslationDispatcher: class {
  constructor() { mocks.construct(); }
  start = mocks.start;
  stop = mocks.stop;
} }));
import { startTranslationOutbox, stopTranslationOutbox, translationOutboxRunning } from './runtime';

afterEach(async () => { await stopTranslationOutbox(); });

it('serializes overlapping boot and Country Setup starts, stop, and restart', async () => {
  let release!: () => void;
  mocks.locales.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return [{ code: 'ar' }];
  });
  const boot = startTranslationOutbox({} as any);
  const countrySetup = startTranslationOutbox({} as any);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const stop = stopTranslationOutbox();
  expect(translationOutboxRunning()).toBe(false);
  const restart = startTranslationOutbox({} as any);
  expect(mocks.construct).not.toHaveBeenCalled();
  release();
  await Promise.all([boot, countrySetup, stop, restart]);
  expect(mocks.construct).toHaveBeenCalledTimes(2);
  expect(mocks.start).toHaveBeenCalledTimes(2);
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  expect(translationOutboxRunning()).toBe(true);
});

it('waits for an active instance to finish stopping before starting its replacement', async () => {
  await startTranslationOutbox({} as any);
  let release!: () => void;
  mocks.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const stop = stopTranslationOutbox();
  expect(translationOutboxRunning()).toBe(false);
  const restart = startTranslationOutbox({} as any);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(mocks.construct).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([stop, restart]);
  expect(mocks.construct).toHaveBeenCalledTimes(2);
});
