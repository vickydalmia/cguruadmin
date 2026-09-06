import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startTranslationOutbox,
  translationOutboxRunning,
} from './runtime';

describe('translation outbox runtime role', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not inspect provider or locale configuration on a disabled process', async () => {
    vi.stubEnv('CRON_ENABLED', 'false');
    vi.stubEnv('TRANSLATION_OUTBOX_DISPATCHER_ENABLED', '');
    vi.stubEnv('TRANSLATION_PROVIDER', '');
    const info = vi.fn();
    const strapi = { log: { info, warn: vi.fn(), error: vi.fn() } } as any;

    await expect(startTranslationOutbox(strapi)).resolves.toBeUndefined();

    expect(translationOutboxRunning()).toBe(false);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"CRON_ENABLED=false fallback"'),
    );
  });
});
