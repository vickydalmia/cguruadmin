import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  translationConfigFromEnv,
  translationConfigProblem,
} from './config';

function validEnvironment(): void {
  vi.stubEnv('TRANSLATION_PROVIDER', 'openai-compatible');
  vi.stubEnv('TRANSLATION_API_KEY', 'secret');
  vi.stubEnv('TRANSLATION_MODEL', 'writer-model');
  vi.stubEnv('TRANSLATION_BASE_URL', 'https://provider.example/v1');
}

describe('translation environment configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses a daily budget that cannot price provider calls', () => {
    validEnvironment();
    vi.stubEnv('TRANSLATION_DAILY_BUDGET_USD', '10');
    vi.stubEnv('TRANSLATION_INPUT_COST_PER_MTOK', '0');
    vi.stubEnv('TRANSLATION_OUTPUT_COST_PER_MTOK', '2');

    expect(translationConfigFromEnv()).toBeNull();
    expect(translationConfigProblem()).toContain(
      'TRANSLATION_INPUT_COST_PER_MTOK must be positive',
    );
  });

  it('accepts positive rates when the concurrency-safe budget is enabled', () => {
    validEnvironment();
    vi.stubEnv('TRANSLATION_DAILY_BUDGET_USD', '10');
    vi.stubEnv('TRANSLATION_INPUT_COST_PER_MTOK', '1.25');
    vi.stubEnv('TRANSLATION_OUTPUT_COST_PER_MTOK', '5');

    expect(translationConfigProblem()).toBeNull();
    expect(translationConfigFromEnv()).toMatchObject({
      dailyBudgetUsd: 10,
      inputCostPerMTok: 1.25,
      outputCostPerMTok: 5,
    });
  });
});
