import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTranslationOutboxConfig } from './config';

describe('translation outbox configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('enables the dispatcher by default on the admin process', () => {
    vi.stubEnv('CRON_ENABLED', 'true');
    vi.stubEnv('TRANSLATION_OUTBOX_DISPATCHER_ENABLED', '');
    expect(readTranslationOutboxConfig().enabled).toBe(true);
  });

  it('inherits the existing render-process cron role when no override exists', () => {
    vi.stubEnv('CRON_ENABLED', 'false');
    vi.stubEnv('TRANSLATION_OUTBOX_DISPATCHER_ENABLED', '');
    expect(readTranslationOutboxConfig().enabled).toBe(false);
  });

  it('allows the translation worker role to be selected explicitly', () => {
    vi.stubEnv('CRON_ENABLED', 'false');
    vi.stubEnv('TRANSLATION_OUTBOX_DISPATCHER_ENABLED', 'true');
    expect(readTranslationOutboxConfig().enabled).toBe(true);
  });

  it('rejects ambiguous dispatcher switches', () => {
    vi.stubEnv('TRANSLATION_OUTBOX_DISPATCHER_ENABLED', 'off');
    expect(() => readTranslationOutboxConfig()).toThrow(/must be true or false/);
  });
});
