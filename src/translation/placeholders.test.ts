import { describe, expect, it } from 'vitest';

import { keepsProtectedValues } from './placeholders';

describe('keepsProtectedValues', () => {
  it('passes when every placeholder survives, in any order', () => {
    expect(keepsProtectedValues('Hi {name}, {count} left', '{count} متبقية يا {name}')).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('lists each missing placeholder occurrence in source order', () => {
    expect(keepsProtectedValues('{a} and {b} and {a}', 'only {a}')).toEqual({
      ok: false,
      missing: ['{b}', '{a}'],
    });
  });

  it('tolerates values the editor adds but keeps numbers and URLs', () => {
    expect(keepsProtectedValues('View all', 'View all 3 offers').ok).toBe(true);
    expect(keepsProtectedValues('Save 20% at https://x.test/a', 'Save at https://x.test/a')).toEqual({
      ok: false,
      missing: ['20%', '20'],
    });
  });
});
