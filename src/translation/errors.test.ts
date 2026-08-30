import { describe, expect, it } from 'vitest';
import { TranslationError } from './errors';

describe('translation retry policy', () => {
  it('automatically retries automated quality-gate failures', () => {
    expect(
      new TranslationError('TRANSLATION_QUALITY_GATE_FAILED').retryable,
    ).toBe(true);
  });

  it('retries malformed provider envelopes without publishing them', () => {
    expect(new TranslationError('TRANSLATION_MALFORMED_OUTPUT').retryable).toBe(
      true,
    );
  });
});
