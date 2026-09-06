import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { catalogueEntryHash, catalogueVersion } from './hash';

describe('catalogueEntryHash', () => {
  it('is sha256 of [text, maxLength ?? null]', () => {
    expect(catalogueEntryHash('View all', 40)).toBe(
      createHash('sha256').update(JSON.stringify(['View all', 40])).digest('hex'),
    );
    expect(catalogueEntryHash('View all')).toBe(catalogueEntryHash('View all', null));
    expect(catalogueEntryHash('View all')).toBe(
      createHash('sha256').update(JSON.stringify(['View all', null])).digest('hex'),
    );
  });

  it('changes when either the text or the length budget changes', () => {
    const base = catalogueEntryHash('View all', 40);
    expect(catalogueEntryHash('View all', 60)).not.toBe(base);
    expect(catalogueEntryHash('View all ', 40)).not.toBe(base);
  });
});

describe('catalogueVersion', () => {
  it('is independent of key order and of undefined optional fields', () => {
    const a = catalogueVersion({
      'common.viewAll': { text: 'View all' },
      'seo.defaultTitle': { text: 'Coupons', maxLength: 60 },
    });
    const b = catalogueVersion({
      'seo.defaultTitle': { text: 'Coupons', maxLength: 60, description: undefined },
      'common.viewAll': { text: 'View all', pluralOf: undefined },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any entry field changes', () => {
    const base = catalogueVersion({ 'common.viewAll': { text: 'View all' } });
    expect(catalogueVersion({ 'common.viewAll': { text: 'View all', description: 'x' } })).not.toBe(base);
    expect(catalogueVersion({ 'common.viewAll': { text: 'View all', maxLength: 5 } })).not.toBe(base);
  });
});
