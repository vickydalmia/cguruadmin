import { describe, expect, it } from 'vitest';
import { computeContentStatus, publishedOnlyFilters } from './content-status';

describe('computeContentStatus', () => {
  const now = new Date('2026-07-14T12:00:00.000Z');

  it('returns expired when expiresAt has passed', () => {
    expect(computeContentStatus({ expiresAt: '2026-07-14T11:59:59.000Z', now })).toBe('expired');
  });

  it('returns scheduled when scheduledAt is in the future', () => {
    expect(computeContentStatus({ scheduledAt: '2026-07-15T00:00:00.000Z', now })).toBe('scheduled');
  });

  it('returns published when no dates constrain visibility', () => {
    expect(computeContentStatus({ now })).toBe('published');
    expect(computeContentStatus({ scheduledAt: '2026-07-01T00:00:00.000Z', now })).toBe('published');
  });

  it('expiry wins over a future scheduledAt', () => {
    expect(
      computeContentStatus({
        scheduledAt: '2026-07-15T00:00:00.000Z',
        expiresAt: '2026-07-14T00:00:00.000Z',
        now,
      }),
    ).toBe('expired');
  });
});

describe('publishedOnlyFilters', () => {
  it('requires published contentStatus and a live (or absent) expiresAt', () => {
    const before = Date.now();
    const filters = publishedOnlyFilters();
    const after = Date.now();

    expect(filters.contentStatus).toEqual({ $eq: 'published' });
    const [expiry] = filters.$and;
    expect(expiry.$or[0]).toEqual({ expiresAt: { $null: true } });
    const cutoff = new Date(expiry.$or[1].expiresAt.$gt).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
  });

  it('reserves only contentStatus and $and keys so call sites with $or can spread it safely', () => {
    expect(Object.keys(publishedOnlyFilters()).sort()).toEqual(['$and', 'contentStatus']);
  });
});
