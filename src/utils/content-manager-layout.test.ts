import { describe, expect, it } from 'vitest';
import {
  appendListColumns,
  isSortableListColumn,
  pinFieldToFullRow,
  removeEditLayoutFields,
  type EditLayout,
} from './content-manager-layout';

describe('removeEditLayoutFields', () => {
  it('removes hidden fields while preserving every remaining row and cell', () => {
    const edit: EditLayout = [
      [
        { name: 'desktopImage', size: 6 },
        { name: 'order', size: 6 },
      ],
      [{ name: 'link', size: 12 }],
    ];

    expect(removeEditLayoutFields(edit, ['order'])).toEqual([
      [{ name: 'desktopImage', size: 6 }],
      [{ name: 'link', size: 12 }],
    ]);
  });

  it('drops rows that become empty and is idempotent', () => {
    const edit: EditLayout = [
      [{ name: 'order', size: 12 }],
      [{ name: 'link', size: 12 }],
    ];
    const next = removeEditLayoutFields(edit, ['order'])!;

    expect(next).toEqual([[{ name: 'link', size: 12 }]]);
    expect(removeEditLayoutFields(next, ['order'])).toBeNull();
  });
});

describe('isSortableListColumn', () => {
  it.each([
    ['string', { type: 'string' }],
    ['datetime', { type: 'datetime' }],
    ['uid', { type: 'uid' }],
    ['boolean', { type: 'boolean' }],
    ['decimal', { type: 'decimal' }],
    ['integer', { type: 'integer' }],
    ['enumeration', { type: 'enumeration' }],
    ['text', { type: 'text' }],
    ['manyToOne relation', { type: 'relation', relationType: 'manyToOne' }],
  ])('accepts %s', (_label, attribute) => {
    expect(isSortableListColumn(attribute)).toBe(true);
  });

  it.each([
    ['media', { type: 'media' }],
    ['richtext', { type: 'richtext' }],
    ['component', { type: 'component' }],
    ['json', { type: 'json' }],
    ['blocks', { type: 'blocks' }],
    ['dynamiczone', { type: 'dynamiczone' }],
    ['password', { type: 'password' }],
    ['manyToMany relation', { type: 'relation', relationType: 'manyToMany' }],
    ['oneToMany relation', { type: 'relation', relationType: 'oneToMany' }],
  ])('rejects %s', (_label, attribute) => {
    expect(isSortableListColumn(attribute)).toBe(false);
  });

  it('rejects a missing or malformed attribute', () => {
    expect(isSortableListColumn(undefined)).toBe(false);
    expect(isSortableListColumn({})).toBe(false);
  });
});

describe('pinFieldToFullRow', () => {
  it('widens the field and pushes its row-mates into the next row', () => {
    const edit: EditLayout = [
      [
        { name: 'title', size: 6 },
        { name: 'offerText', size: 6 },
      ],
      [{ name: 'content', size: 12 }],
    ];

    expect(pinFieldToFullRow(edit, 'title')).toEqual([
      [{ name: 'title', size: 12 }],
      [{ name: 'offerText', size: 6 }],
      [{ name: 'content', size: 12 }],
    ]);
  });

  it('drops no field and never overflows a row', () => {
    const edit: EditLayout = [
      [
        { name: 'a', size: 4 },
        { name: 'title', size: 4 },
        { name: 'b', size: 4 },
      ],
      [{ name: 'c', size: 6 }],
    ];

    const next = pinFieldToFullRow(edit, 'title')!;
    expect(next.flat().map((cell) => cell.name).sort()).toEqual(['a', 'b', 'c', 'title']);
    for (const row of next) {
      expect(row.reduce((sum, cell) => sum + cell.size, 0)).toBeLessThanOrEqual(12);
    }
  });

  it('is idempotent once the field owns its row', () => {
    const edit: EditLayout = [
      [{ name: 'title', size: 12 }],
      [{ name: 'offerText', size: 6 }],
    ];

    expect(pinFieldToFullRow(edit, 'title')).toBeNull();
  });

  it('re-runs cleanly: applying the result again is a no-op', () => {
    const edit: EditLayout = [
      [
        { name: 'title', size: 6 },
        { name: 'offerText', size: 6 },
      ],
    ];

    const once = pinFieldToFullRow(edit, 'title')!;
    expect(pinFieldToFullRow(once, 'title')).toBeNull();
  });

  it('leaves a field that is not in the layout alone', () => {
    const edit: EditLayout = [[{ name: 'title', size: 12 }]];

    // Relations hidden by hideRelationsFromContentManager must stay hidden.
    expect(pinFieldToFullRow(edit, 'stores')).toBeNull();
    expect(pinFieldToFullRow([], 'title')).toBeNull();
  });
});

describe('appendListColumns', () => {
  it('appends the missing columns after the existing ones', () => {
    expect(appendListColumns(['title', 'code'], ['scheduledAt', 'expiresAt'])).toEqual([
      'title',
      'code',
      'scheduledAt',
      'expiresAt',
    ]);
  });

  it('keeps columns that are already displayed in place', () => {
    expect(appendListColumns(['name', 'slug'], ['name', 'isVerified'])).toEqual([
      'name',
      'slug',
      'isVerified',
    ]);
  });

  it('returns null when every column is already displayed', () => {
    expect(appendListColumns(['name', 'isVerified'], ['name', 'isVerified'])).toBeNull();
    expect(appendListColumns(['name'], [])).toBeNull();
  });

  it('does not duplicate a column requested twice', () => {
    expect(appendListColumns(['name'], ['ratingCount', 'ratingCount'])).toEqual([
      'name',
      'ratingCount',
    ]);
  });
});
