import { describe, expect, it } from 'vitest';
import { slugify } from './slugify';

describe('slugify', () => {
  // Each of these produced the "before" value with the old NFKD-then-collapse
  // implementation, which turned combining marks into dashes and let
  // compatibility expansions of symbols leak into the slug.
  const regressions: Array<[input: string, expected: string, before: string]> = [
    ['Häagen-Dazs', 'haagen-dazs', 'ha-agen-dazs'],
    ['Sephora™', 'sephora', 'sephoratm'],
    ['Æon', 'aeon', 'on'],
    ['½ Price', 'price', '1-2-price'],
  ];

  it.each(regressions)('slugifies %j to %j (was %j)', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  // Names that already slugified correctly; the reordering must not move them.
  const unchanged: Array<[input: string, expected: string]> = [
    ["Levi's", 'levi-s'],
    ['M&S', 'm-s'],
    ['Nykaa Fashion', 'nykaa-fashion'],
    ['Amazon@#$%', 'amazon'],
    ['!!!', ''],
    ['', ''],
    ['  Spaced  Out  ', 'spaced-out'],
    ['Already-A-Slug', 'already-a-slug'],
  ];

  it.each(unchanged)('leaves %j slugifying to %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  const accentsAndLigatures: Array<[input: string, expected: string]> = [
    ['Nescafé', 'nescafe'],
    ['Björn Borg', 'bjorn-borg'],
    ['Ångström', 'angstrom'],
    ['Côte d’Or', 'cote-d-or'],
    ['œuvre', 'oeuvre'],
    ['Straße', 'strasse'],
    ['Łódź', 'lodz'],
    ['Đông', 'dong'],
    // Turkish dotted capital I decomposes to 'I' + combining dot above.
    ['İstanbul', 'istanbul'],
    ['Højskole', 'hojskole'],
  ];

  it.each(accentsAndLigatures)('folds %j to %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('drops invisible format characters instead of dashing them', () => {
    // Zero-width joiner / soft hyphen survive copy-paste from a CMS or a PDF
    // and are unrecognisable to the editor, so they must never split a word.
    expect(slugify('Sam­sung')).toBe('samsung');
    expect(slugify('Nike‍just do it')).toBe('nikejust-do-it');
  });

  it('yields an empty slug for input with no slug-able characters', () => {
    // Callers decide the fallback (the upload extension substitutes "image").
    expect(slugify('日本語')).toBe('');
    expect(slugify('™®©')).toBe('');
  });
});
