import { describe, expect, it } from 'vitest';
import { readAdsDebugLogging, readAdsGeneratorConfig, readAdsUsageLimits } from './config';

describe('readAdsGeneratorConfig', () => {
  it('is null until both key and model are set', () => {
    expect(readAdsGeneratorConfig({})).toBeNull();
    expect(readAdsGeneratorConfig({ ADS_GENERATOR_OPENAI_API_KEY: 'sk-x' })).toBeNull();
    expect(readAdsGeneratorConfig({ ADS_GENERATOR_OPENAI_API_KEY: 'sk-x', ADS_GENERATOR_MODEL: 'm' }))
      .toEqual({ apiKey: 'sk-x', model: 'm', reasoningEffort: 'low', maxOutputTokens: 16000, timeoutMs: 180000 });
  });

  it('reads the output budget and timeout from env, falling back on bad values', () => {
    const base = { ADS_GENERATOR_OPENAI_API_KEY: 'sk-x', ADS_GENERATOR_MODEL: 'm' };
    expect(readAdsGeneratorConfig({ ...base, ADS_GENERATOR_MAX_OUTPUT_TOKENS: '32000', ADS_GENERATOR_TIMEOUT_MS: '240000' }))
      .toMatchObject({ maxOutputTokens: 32000, timeoutMs: 240000 });
    expect(readAdsGeneratorConfig({ ...base, ADS_GENERATOR_MAX_OUTPUT_TOKENS: '0', ADS_GENERATOR_TIMEOUT_MS: 'slow' }))
      .toMatchObject({ maxOutputTokens: 16000, timeoutMs: 180000 });
  });
});

describe('readAdsUsageLimits', () => {
  it('reads the limits from env', () => {
    expect(readAdsUsageLimits({
      ADS_GENERATOR_MAX_REQUESTS_PER_USER_PER_HOUR: '50',
      ADS_GENERATOR_MAX_REQUESTS_PER_DAY: ' 500 ',
    })).toEqual({ maxRequestsPerUserPerHour: 50, maxRequestsPerDay: 500 });
  });

  it('falls back to the defaults for blank, zero, negative or non-integer values', () => {
    const defaults = { maxRequestsPerUserPerHour: 10, maxRequestsPerDay: 100 };
    expect(readAdsUsageLimits({})).toEqual(defaults);
    for (const value of ['', '0', '-5', '2.5', 'ten']) {
      expect(readAdsUsageLimits({
        ADS_GENERATOR_MAX_REQUESTS_PER_USER_PER_HOUR: value,
        ADS_GENERATOR_MAX_REQUESTS_PER_DAY: value,
      })).toEqual(defaults);
    }
  });
});

describe('readAdsDebugLogging', () => {
  it('is on only for an explicit true', () => {
    expect(readAdsDebugLogging({})).toBe(false);
    expect(readAdsDebugLogging({ ADS_GENERATOR_DEBUG_LOG: 'false' })).toBe(false);
    expect(readAdsDebugLogging({ ADS_GENERATOR_DEBUG_LOG: '1' })).toBe(false);
    expect(readAdsDebugLogging({ ADS_GENERATOR_DEBUG_LOG: ' TRUE ' })).toBe(true);
  });
});
