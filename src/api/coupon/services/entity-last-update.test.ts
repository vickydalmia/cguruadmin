import { describe, expect, it } from 'vitest';

import { selectLatestEntityUpdate } from './entity-last-update';

describe('entity last-update attribution', () => {
  it('uses the latest related Coupon updater when its edit is newer', () => {
    expect(
      selectLatestEntityUpdate(
        {
          updatedAt: '2026-03-20T10:00:00.000Z',
          firstname: 'Entity',
          lastname: 'Editor',
        },
        {
          updatedAt: '2026-03-24T10:00:00.000Z',
          firstname: 'Vinayak',
          lastname: 'Sharma',
        },
      ),
    ).toEqual({
      updatedAt: '2026-03-24T10:00:00.000Z',
      updatedByName: 'Vinayak Sharma',
    });
  });

  it('uses the entity updater when the entity edit is newer or tied', () => {
    expect(
      selectLatestEntityUpdate(
        {
          updatedAt: '2026-03-24T10:00:00.000Z',
          username: 'entity-editor',
        },
        {
          updatedAt: '2026-03-23T10:00:00.000Z',
          firstname: 'Coupon',
          lastname: 'Editor',
        },
      ),
    ).toEqual({
      updatedAt: '2026-03-24T10:00:00.000Z',
      updatedByName: 'entity-editor',
    });
  });

  it('falls back to CouponzGuru Team when no updater name exists', () => {
    expect(
      selectLatestEntityUpdate(
        { updatedAt: new Date('2026-03-24T10:00:00.000Z') },
        null,
      ),
    ).toEqual({
      updatedAt: '2026-03-24T10:00:00.000Z',
      updatedByName: 'CouponzGuru Team',
    });
  });

  it('rejects invalid timestamps instead of presenting false freshness', () => {
    expect(
      selectLatestEntityUpdate(
        { updatedAt: 'invalid', firstname: 'Entity' },
        { updatedAt: '', firstname: 'Coupon' },
      ),
    ).toEqual({
      updatedAt: null,
      updatedByName: 'Entity',
    });
  });
});
