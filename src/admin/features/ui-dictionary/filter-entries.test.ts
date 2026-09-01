import { describe, expect, it } from 'vitest';

import {
  countByStatus,
  filterEntries,
  namespaceOf,
  namespacesOf,
  statusOptionsFor,
} from './filter-entries';
import type { UiDictionaryEntry } from './types';

function entry(
  key: string,
  status: UiDictionaryEntry['status'],
  extra: { english?: string; translation?: string; removed?: boolean; override?: string } = {},
): UiDictionaryEntry {
  const text = extra.english ?? key;
  return {
    key,
    locale: 'ar',
    source: {
      text,
      overrideText: extra.override ?? null,
      effectiveText: extra.override ?? text,
      effectiveHash: 'h',
      description: null,
      maxLength: null,
      pluralOf: null,
      pluralCategory: null,
      expanded: false,
      removedAt: extra.removed ? '2026-09-01T00:00:00.000Z' : null,
    },
    translation: extra.translation
      ? { text: extra.translation, origin: 'ai', sourceHash: 'h', updatedBy: null, updatedAt: null }
      : null,
    status,
  };
}

const ROWS: UiDictionaryEntry[] = [
  entry('common.viewAll', 'ai', { english: 'View all', translation: 'عرض الكل' }),
  entry('common.close', 'missing', { english: 'Close' }),
  entry('offers.count.other', 'manual', { english: '{count} offers', translation: '{count} عروض' }),
  entry('offers.old', 'ai', { english: 'Old', translation: 'قديم', removed: true }),
  entry('nav.home', 'stale', { english: 'Home', override: 'Homepage', translation: 'الرئيسية' }),
];

const NONE = { search: '', status: '', namespace: '', showRemoved: false };

describe('namespaces', () => {
  it('takes the first key segment', () => {
    expect(namespaceOf('offers.count.other')).toBe('offers');
    expect(namespaceOf('flat')).toBe('flat');
    expect(namespacesOf(ROWS)).toEqual(['common', 'nav', 'offers']);
  });
});

describe('filterEntries', () => {
  it('hides removed keys unless asked to show them', () => {
    expect(filterEntries(ROWS, NONE).map((row) => row.key)).not.toContain('offers.old');
    expect(filterEntries(ROWS, { ...NONE, showRemoved: true }).map((row) => row.key)).toContain('offers.old');
  });

  it('filters by namespace and status', () => {
    expect(filterEntries(ROWS, { ...NONE, namespace: 'common' }).map((row) => row.key)).toEqual([
      'common.viewAll',
      'common.close',
    ]);
    expect(filterEntries(ROWS, { ...NONE, status: 'stale' }).map((row) => row.key)).toEqual(['nav.home']);
  });

  it('searches key, catalogue English, overridden English and translation case-insensitively', () => {
    const keys = (search: string) => filterEntries(ROWS, { ...NONE, search }).map((row) => row.key);
    expect(keys('VIEWALL')).toEqual(['common.viewAll']);
    expect(keys('close')).toEqual(['common.close']);
    expect(keys('homepage')).toEqual(['nav.home']);
    expect(keys('home')).toEqual(['nav.home']);
    expect(keys('عروض')).toEqual(['offers.count.other']);
    expect(keys('  ')).toHaveLength(4);
  });
});

describe('countByStatus and status options', () => {
  it('counts live rows per status', () => {
    expect(countByStatus(ROWS)).toEqual({ ai: 1, missing: 1, manual: 1, stale: 1 });
  });

  it('offers English and target statuses separately', () => {
    expect(statusOptionsFor('en').map((option) => option.value)).toEqual(['source', 'override']);
    expect(statusOptionsFor('ar').map((option) => option.value)).toEqual(['missing', 'stale', 'ai', 'manual']);
  });
});
