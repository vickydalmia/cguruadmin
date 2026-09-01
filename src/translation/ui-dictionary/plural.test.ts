import { describe, expect, it } from 'vitest';
import {
  pluralCategoriesFor,
  pluralExpansions,
  pluralNote,
  resolveSourceRow,
  splitPluralKey,
} from './plural';
import type { CatalogueRow } from './types';

export function catalogueRow(overrides: Partial<CatalogueRow> & { key: string }): CatalogueRow {
  return {
    text: overrides.key,
    description: null,
    maxLength: null,
    pluralOf: null,
    hash: `hash:${overrides.key}`,
    overrideText: null,
    effectiveHash: `hash:${overrides.key}`,
    overrideUpdatedBy: null,
    overrideUpdatedAt: null,
    firstSeenAt: null,
    lastSeenAt: null,
    removedAt: null,
    ...overrides,
  };
}

const one = catalogueRow({ key: 'offers.count.one', text: '{count} offer', pluralOf: 'offers.count' });
const other = catalogueRow({ key: 'offers.count.other', text: '{count} offers', pluralOf: 'offers.count' });

describe('pluralCategoriesFor', () => {
  it('returns the CLDR categories of the locale in CLDR order', () => {
    expect(pluralCategoriesFor('ar')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
    expect(pluralCategoriesFor('en')).toEqual(['one', 'other']);
    expect(pluralCategoriesFor('ru')).toEqual(['one', 'few', 'many', 'other']);
    expect(pluralCategoriesFor('ja')).toEqual(['other']);
  });

  it('falls back to `other` for an invalid tag', () => {
    expect(pluralCategoriesFor('')).toEqual(['other']);
    expect(pluralCategoriesFor('not a tag')).toEqual(['other']);
  });
});

describe('pluralNote', () => {
  it('names the category and a count that selects it', () => {
    expect(pluralNote('ar', 'few')).toBe("plural form 'few' for a count like 3");
    expect(pluralNote('ar', 'zero')).toBe("plural form 'zero' for a count like 0");
    expect(pluralNote('en', 'one')).toBe("plural form 'one' for a count like 1");
    expect(pluralNote('fr', 'many')).toMatch(/^plural form 'many' for a count like 1000000$/);
  });
});

describe('splitPluralKey', () => {
  it('splits only on a trailing CLDR category', () => {
    expect(splitPluralKey('offers.count.few')).toEqual({ base: 'offers.count', category: 'few' });
    expect(splitPluralKey('offers.count')).toBeNull();
    expect(splitPluralKey('other')).toBeNull();
  });
});

describe('pluralExpansions', () => {
  it('yields the categories the locale needs that English did not push', () => {
    const expansions = pluralExpansions([one, other], 'ar');
    expect(expansions.map((expansion) => expansion.key)).toEqual([
      'offers.count.few',
      'offers.count.many',
      'offers.count.two',
      'offers.count.zero',
    ]);
    expect(expansions.every((expansion) => expansion.other === other)).toBe(true);
    expect(pluralExpansions([one, other], 'en')).toEqual([]);
    expect(pluralExpansions([one, other], 'ja')).toEqual([]);
  });

  it('ignores removed bases and bases without an `other` form', () => {
    expect(pluralExpansions([one, { ...other, removedAt: '2026-08-01T00:00:00.000Z' }], 'ar')).toEqual([]);
    expect(pluralExpansions([one], 'ar')).toEqual([]);
  });
});

describe('resolveSourceRow', () => {
  const live = new Map([one, other].map((row) => [row.key, row]));

  it('resolves pushed keys directly and expansion keys through the base `other`', () => {
    expect(resolveSourceRow(live, 'offers.count.one')).toEqual({ row: one, expandedCategory: null });
    expect(resolveSourceRow(live, 'offers.count.few')).toEqual({ row: other, expandedCategory: 'few' });
  });

  it('rejects unknown keys and look-alikes whose `other` is not a plural base', () => {
    expect(resolveSourceRow(live, 'offers.total')).toBeNull();
    expect(resolveSourceRow(live, 'offers.total.few')).toBeNull();
    const plain = new Map([[ 'colors.other', catalogueRow({ key: 'colors.other' }) ]]);
    expect(resolveSourceRow(plain, 'colors.few')).toBeNull();
  });
});
