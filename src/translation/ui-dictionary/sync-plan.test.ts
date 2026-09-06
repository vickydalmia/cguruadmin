import { describe, expect, it } from 'vitest';
import { catalogueEntryHash } from './hash';
import { planCatalogueSync, type ExistingCatalogueRow } from './sync-plan';

const now = new Date('2026-09-01T00:00:00Z');

function existing(
  key: string,
  text: string,
  extra: Partial<ExistingCatalogueRow> = {},
): ExistingCatalogueRow {
  return {
    key,
    hash: catalogueEntryHash(text, null),
    overrideText: null,
    removedAt: null,
    ...extra,
  };
}

describe('planCatalogueSync', () => {
  it('classifies added, changed, revived and removed keys', () => {
    const plan = planCatalogueSync(
      [
        existing('common.viewAll', 'View all'),
        existing('common.home', 'Home'),
        existing('common.old', 'Old'),
        existing('common.gone', 'Gone', { removedAt: '2026-08-01T00:00:00.000Z' }),
        existing('common.back', 'Back', { removedAt: '2026-08-01T00:00:00.000Z' }),
      ],
      {
        'common.viewAll': { text: 'View all' },
        'common.home': { text: 'Home page' },
        'common.new': { text: 'New' },
        'common.back': { text: 'Back' },
      },
      now,
    );
    expect(plan.added).toEqual(['common.new']);
    expect(plan.changed).toEqual(['common.home']);
    expect(plan.revived).toEqual(['common.back']);
    // `common.gone` was already removed: not counted again.
    expect(plan.removed).toEqual(['common.old']);
    expect(plan.upserts.map((row) => row.key)).toEqual([
      'common.back',
      'common.home',
      'common.new',
      'common.viewAll',
    ]);
    expect(plan.upserts.every((row) => row.removed_at === null && row.last_seen_at === now)).toBe(true);
  });

  it('keeps the existing English override and hashes effective text against it', () => {
    const plan = planCatalogueSync(
      [existing('common.viewAll', 'View all', { overrideText: 'See everything' })],
      { 'common.viewAll': { text: 'View all offers', maxLength: 30 } },
      now,
    );
    const row = plan.upserts[0];
    expect(row.hash).toBe(catalogueEntryHash('View all offers', 30));
    expect(row.override_text).toBe('See everything');
    expect(row.effective_hash).toBe(catalogueEntryHash('See everything', 30));
    expect(plan.changed).toEqual(['common.viewAll']);
  });

  it('hashes new rows on their own text and carries plural metadata', () => {
    const plan = planCatalogueSync(
      [],
      {
        'offers.count.other': { text: '{count} offers', pluralOf: 'offers.count', description: 'Card count' },
      },
      now,
    );
    expect(plan.upserts[0]).toMatchObject({
      key: 'offers.count.other',
      plural_of: 'offers.count',
      description: 'Card count',
      max_length: null,
      override_text: null,
      hash: catalogueEntryHash('{count} offers', null),
      effective_hash: catalogueEntryHash('{count} offers', null),
    });
    expect(plan.added).toEqual(['offers.count.other']);
  });
});
