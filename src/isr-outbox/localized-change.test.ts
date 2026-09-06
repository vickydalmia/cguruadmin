import { describe, expect, it } from 'vitest';
import {
  sharedFieldSelection,
  sharedFieldSnapshot,
  sharedFieldSnapshotsDiffer,
} from './localized-change';

const model = {
  attributes: {
    title: { type: 'string', pluginOptions: { i18n: { localized: true } } },
    slug: { type: 'string' },
    visible: { type: 'boolean' },
    logo: { type: 'media' },
    stores: { type: 'relation' },
  },
};

describe('localized ISR shared-field change detection', () => {
  it('ignores unchanged shared fields resent by a full localized form', () => {
    const selection = sharedFieldSelection(model, {
      title: 'Edited English title',
      slug: 'amazon',
      visible: true,
      logo: 7,
      stores: [{ documentId: 'store-1' }],
    });
    expect(selection).toEqual({
      scalars: ['slug', 'visible'],
      media: ['logo'],
      unknown: false,
    });
    const before = sharedFieldSnapshot(
      { slug: 'amazon', visible: true, logo: { documentId: 'file-1' } },
      selection,
    );
    const after = sharedFieldSnapshot(
      { slug: 'amazon', visible: true, logo: { documentId: 'file-1' } },
      selection,
    );
    expect(sharedFieldSnapshotsDiffer(before, after)).toBe(false);
  });

  it('detects persisted scalar and media changes', () => {
    const selection = sharedFieldSelection(model, { slug: 'new', logo: 8 });
    const before = sharedFieldSnapshot(
      { slug: 'old', logo: { documentId: 'file-1' } },
      selection,
    );
    const after = sharedFieldSnapshot(
      { slug: 'new', logo: { documentId: 'file-2' } },
      selection,
    );
    expect(sharedFieldSnapshotsDiffer(before, after)).toBe(true);
  });

  it('fails toward shared invalidation for unknown fields or failed snapshots', () => {
    expect(sharedFieldSelection(model, { mystery: true }).unknown).toBe(true);
    expect(sharedFieldSnapshotsDiffer(null, {})).toBe(true);
  });
});
