import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The queue holds module-level state (pending scope, timer, retry counter), so
// every test re-imports a fresh module instance with its own mocked worker.
vi.mock('./worker', () => ({
  executeRebuild: vi.fn(),
}));

function fakeStrapi() {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

async function freshQueue(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const queue = await import('./queue');
  const worker = await import('./worker');
  return { queue, executeRebuild: vi.mocked(worker.executeRebuild) };
}

describe('rebuild queue delivery retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('retries a failed delivery after the debounce window', async () => {
    const { queue, executeRebuild } = await freshQueue({
      REBUILD_ENABLED: 'true',
      REBUILD_DEBOUNCE_MS: '10',
      REBUILD_MAX_RETRIES: '5',
    });
    const strapi = fakeStrapi();
    executeRebuild.mockRejectedValueOnce(new Error('gateway down'));
    executeRebuild.mockResolvedValue(undefined);

    queue.enqueue(strapi, { homepage: true }, 'test edit');
    await vi.advanceTimersByTimeAsync(15); // first (failing) delivery
    await vi.advanceTimersByTimeAsync(15); // retry succeeds

    expect(executeRebuild).toHaveBeenCalledTimes(2);
    expect(executeRebuild.mock.calls[1]![1]).toMatchObject({ homepage: true });
    queue.destroyRebuildQueue();
  });

  it('gives up after REBUILD_MAX_RETRIES consecutive failures instead of retrying forever', async () => {
    const { queue, executeRebuild } = await freshQueue({
      REBUILD_ENABLED: 'true',
      REBUILD_DEBOUNCE_MS: '10',
      REBUILD_MAX_RETRIES: '3',
    });
    const strapi = fakeStrapi();
    executeRebuild.mockRejectedValue(new Error('gateway down'));

    queue.enqueue(strapi, { full: true }, 'chrome edit');
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(15);
    }

    // 3 attempts total, then the scope is dropped with a loud error.
    expect(executeRebuild).toHaveBeenCalledTimes(3);
    expect(
      strapi.log.error.mock.calls.some(([message]: [string]) =>
        message.includes('GIVING UP'),
      ),
    ).toBe(true);
    queue.destroyRebuildQueue();
  });

  it('resets the failure budget after a successful delivery', async () => {
    const { queue, executeRebuild } = await freshQueue({
      REBUILD_ENABLED: 'true',
      REBUILD_DEBOUNCE_MS: '10',
      REBUILD_MAX_RETRIES: '2',
    });
    const strapi = fakeStrapi();
    executeRebuild
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(undefined);

    queue.enqueue(strapi, { homepage: true }, 'edit one');
    await vi.advanceTimersByTimeAsync(15); // fail (1/2)
    await vi.advanceTimersByTimeAsync(15); // success → budget resets

    queue.enqueue(strapi, { homepage: true }, 'edit two');
    await vi.advanceTimersByTimeAsync(15); // fail again — must be 1/2, not 2/2
    await vi.advanceTimersByTimeAsync(15); // retry succeeds

    expect(executeRebuild).toHaveBeenCalledTimes(4);
    expect(
      strapi.log.error.mock.calls.some(([message]: [string]) =>
        message.includes('GIVING UP'),
      ),
    ).toBe(false);
    queue.destroyRebuildQueue();
  });
});
