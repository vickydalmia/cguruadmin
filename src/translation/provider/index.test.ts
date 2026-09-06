import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationError } from '../errors';
import { completeWithRetry, resetTranslationSlotsForTest } from './index';

const config = {
  timeoutMs: 5_000,
  maxAttempts: 3,
  maxOutputTokens: 500,
};

beforeEach(() => resetTranslationSlotsForTest());

describe('completeWithRetry attempt accounting', () => {
  it('reserves and settles every successful physical provider call', async () => {
    const complete = vi.fn(async () => ({
      text: '{"a":"ب"}',
      inputTokens: 12,
      outputTokens: 4,
      model: 'm',
    }));
    const beforeAttempt = vi.fn(async () => 'reservation-1');
    const afterAttempt = vi.fn(async () => undefined);

    await completeWithRetry(
      { name: 'fake', complete },
      config,
      { system: 'system', user: 'user' },
      { beforeAttempt, afterAttempt },
    );

    expect(beforeAttempt).toHaveBeenCalledOnce();
    expect(afterAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        reservation: 'reservation-1',
        completion: expect.objectContaining({ inputTokens: 12 }),
      }),
    );
  });

  it('does not call the provider when the atomic reservation rejects the budget', async () => {
    const complete = vi.fn();
    await expect(
      completeWithRetry(
        { name: 'fake', complete },
        config,
        { system: 'system', user: 'user' },
        {
          beforeAttempt: async () => {
            throw new TranslationError('TRANSLATION_BUDGET_EXCEEDED');
          },
        },
      ),
    ).rejects.toThrow(/TRANSLATION_BUDGET_EXCEEDED/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not repeat a paid provider call when ledger settlement fails', async () => {
    const complete = vi.fn(async () => ({
      text: '{}',
      inputTokens: 1,
      outputTokens: 1,
      model: 'm',
    }));
    await expect(
      completeWithRetry(
        { name: 'fake', complete },
        config,
        { system: 'system', user: 'user' },
        {
          beforeAttempt: async () => 'reservation',
          afterAttempt: async () => {
            throw new Error('ledger unavailable');
          },
        },
      ),
    ).rejects.toThrow('ledger unavailable');
    expect(complete).toHaveBeenCalledOnce();
  });
});
