import { describe, expect, it } from 'vitest';

import { humanizeField, humanizeFieldLower } from './humanize-field';

// Both casing contracts are pinned: the lowercase form renders as a path
// continuation after a section prefix, the capitalized form as a standalone
// label. Changing either changes visible editor copy.
describe('humanizeFieldLower', () => {
  it('turns camelCase attribute names into spaced lowercase', () => {
    expect(humanizeFieldLower('cardImage')).toBe('card image');
    expect(humanizeFieldLower('metaTitle')).toBe('meta title');
    expect(humanizeFieldLower('name')).toBe('name');
  });
});

describe('humanizeField', () => {
  it('turns camelCase attribute names into sentence case', () => {
    expect(humanizeField('websiteUrl')).toBe('Website url');
    expect(humanizeField('metaTitle')).toBe('Meta title');
    expect(humanizeField('name')).toBe('Name');
  });
});
