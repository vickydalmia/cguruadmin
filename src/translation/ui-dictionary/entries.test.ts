import { describe, expect, it } from 'vitest';
import {
  buildEntries,
  isPendingTranslation,
  selectPendingLeaves,
  translationStatus,
} from './entries';
import { catalogueRow } from './plural.test';
import type { TranslationRow } from './types';

function translation(overrides: Partial<TranslationRow> & { key: string }): TranslationRow {
  return {
    locale: 'ar',
    text: `ar:${overrides.key}`,
    sourceHash: `hash:${overrides.key}`,
    origin: 'ai',
    updatedBy: null,
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

const viewAll = catalogueRow({ key: 'common.viewAll', text: 'View all' });
const home = catalogueRow({ key: 'common.home', text: 'Home', overrideText: 'Start', effectiveHash: 'hash:home-override' });
const removed = catalogueRow({ key: 'common.old', removedAt: '2026-08-01T00:00:00.000Z' });
const one = catalogueRow({ key: 'offers.count.one', text: '{count} offer', pluralOf: 'offers.count' });
const other = catalogueRow({ key: 'offers.count.other', text: '{count} offers', pluralOf: 'offers.count', maxLength: 40 });

describe('translationStatus / isPendingTranslation', () => {
  const current = { sourceHash: 'h1', origin: 'manual' as const };
  const stale = { sourceHash: 'h0', origin: 'manual' as const };
  const ai = { sourceHash: 'h1', origin: 'ai' as const };

  it('is the one staleness rule', () => {
    expect(translationStatus('h1', null)).toBe('missing');
    expect(translationStatus('h1', stale)).toBe('stale');
    expect(translationStatus('h1', current)).toBe('manual');
    expect(translationStatus('h1', ai)).toBe('ai');
  });

  it('never selects a current manual row, always a stale one, AI only under force', () => {
    expect(isPendingTranslation('h1', null, false)).toBe(true);
    expect(isPendingTranslation('h1', stale, false)).toBe(true);
    expect(isPendingTranslation('h1', current, false)).toBe(false);
    expect(isPendingTranslation('h1', current, true)).toBe(false);
    expect(isPendingTranslation('h1', ai, false)).toBe(false);
    expect(isPendingTranslation('h1', ai, true)).toBe(true);
  });
});

describe('selectPendingLeaves', () => {
  it('lists missing and stale rows (manual-stale included), skips manual-current and removed', () => {
    const leaves = selectPendingLeaves({
      locale: 'ar',
      catalogue: [viewAll, home, removed],
      translations: [
        translation({ key: 'common.home', origin: 'manual', sourceHash: 'hash:home-old' }),
        translation({ key: 'common.old' }),
      ],
      force: false,
    });
    expect(leaves.map((leaf) => leaf.key)).toEqual(['common.home', 'common.viewAll']);
    expect(leaves[0]).toEqual({
      key: 'common.home',
      text: 'Start',
      sourceHash: 'hash:home-override',
      maxLength: null,
      description: null,
      note: null,
    });
    const settled = selectPendingLeaves({
      locale: 'ar',
      catalogue: [viewAll, home],
      translations: [
        translation({ key: 'common.home', origin: 'manual', sourceHash: 'hash:home-override' }),
        translation({ key: 'common.viewAll', origin: 'ai' }),
      ],
      force: false,
    });
    expect(settled).toEqual([]);
  });

  it('force re-selects current AI rows but still never manual-current rows', () => {
    const leaves = selectPendingLeaves({
      locale: 'ar',
      catalogue: [viewAll, home],
      translations: [
        translation({ key: 'common.home', origin: 'manual', sourceHash: 'hash:home-override' }),
        translation({ key: 'common.viewAll', origin: 'ai' }),
      ],
      force: true,
    });
    expect(leaves.map((leaf) => leaf.key)).toEqual(['common.viewAll']);
  });

  it("expands plural bases to the locale's categories from the English `other`, with notes", () => {
    const leaves = selectPendingLeaves({
      locale: 'ar',
      catalogue: [one, other],
      translations: [translation({ key: 'offers.count.two', sourceHash: 'hash:offers.count.other' })],
      force: false,
    });
    expect(leaves.map((leaf) => leaf.key)).toEqual([
      'offers.count.few',
      'offers.count.many',
      'offers.count.one',
      'offers.count.other',
      'offers.count.zero',
    ]);
    const few = leaves.find((leaf) => leaf.key === 'offers.count.few')!;
    expect(few).toEqual({
      key: 'offers.count.few',
      text: '{count} offers',
      sourceHash: 'hash:offers.count.other',
      maxLength: 40,
      description: null,
      note: "plural form 'few' for a count like 3",
    });
    expect(leaves.find((leaf) => leaf.key === 'offers.count.one')!.note).toBe(
      "plural form 'one' for a count like 1",
    );
    // Japanese has only `other`: no expansion rows, pushed rows still translate.
    expect(
      selectPendingLeaves({ locale: 'ja', catalogue: [one, other], translations: [], force: false }).map(
        (leaf) => leaf.key,
      ),
    ).toEqual(['offers.count.one', 'offers.count.other']);
  });
});

describe('buildEntries', () => {
  it('reports English rows as source/override without translations', () => {
    const entries = buildEntries({ locale: 'en', catalogue: [viewAll, home, removed], translations: [] });
    expect(entries.map((entry) => [entry.key, entry.status, entry.translation])).toEqual([
      ['common.home', 'override', null],
      ['common.viewAll', 'source', null],
    ]);
    expect(entries[0].source.effectiveText).toBe('Start');
    expect(
      buildEntries({ locale: 'en', catalogue: [removed], translations: [], includeRemoved: true }),
    ).toHaveLength(1);
  });

  it('joins the locale rows and appends expanded plural rows', () => {
    const entries = buildEntries({
      locale: 'ar',
      catalogue: [viewAll, one, other],
      translations: [
        translation({ key: 'common.viewAll', origin: 'manual', updatedBy: 7 }),
        translation({ key: 'offers.count.few', sourceHash: 'stale' }),
      ],
    });
    const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
    expect(byKey['common.viewAll']).toMatchObject({
      status: 'manual',
      translation: { text: 'ar:common.viewAll', origin: 'manual', updatedBy: 7 },
      source: { expanded: false, pluralCategory: null },
    });
    expect(byKey['offers.count.one']).toMatchObject({
      status: 'missing',
      source: { pluralOf: 'offers.count', pluralCategory: 'one', expanded: false },
    });
    expect(byKey['offers.count.few']).toMatchObject({
      status: 'stale',
      source: {
        text: '{count} offers',
        effectiveHash: 'hash:offers.count.other',
        pluralOf: 'offers.count',
        pluralCategory: 'few',
        expanded: true,
        maxLength: 40,
      },
    });
    expect(byKey['offers.count.zero'].status).toBe('missing');
    expect(Object.keys(byKey)).toHaveLength(7);
  });
});
