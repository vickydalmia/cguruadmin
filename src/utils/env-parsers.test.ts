import { afterEach, describe, expect, it } from 'vitest';

import { booleanEnv, integerEnv } from './env-parsers';

const NAME = 'ENV_PARSERS_TEST_VALUE';

afterEach(() => {
  delete process.env[NAME];
});

describe('booleanEnv', () => {
  it('returns the fallback for unset or blank values', () => {
    expect(booleanEnv(NAME, true)).toBe(true);
    process.env[NAME] = '   ';
    expect(booleanEnv(NAME, false)).toBe(false);
  });

  it('parses true/false case-insensitively and rejects anything else', () => {
    process.env[NAME] = 'TRUE';
    expect(booleanEnv(NAME, false)).toBe(true);
    process.env[NAME] = 'false';
    expect(booleanEnv(NAME, true)).toBe(false);
    process.env[NAME] = 'yes';
    expect(() => booleanEnv(NAME, true)).toThrow(`${NAME} must be true or false`);
  });
});

describe('integerEnv', () => {
  it('returns the fallback when unset and enforces the bounds', () => {
    expect(integerEnv(NAME, 6, 1, 24)).toBe(6);
    process.env[NAME] = '12';
    expect(integerEnv(NAME, 6, 1, 24)).toBe(12);
    process.env[NAME] = '25';
    expect(() => integerEnv(NAME, 6, 1, 24)).toThrow('between 1 and 24');
    process.env[NAME] = '1.5';
    expect(() => integerEnv(NAME, 6, 1, 24)).toThrow('between 1 and 24');
  });
});
