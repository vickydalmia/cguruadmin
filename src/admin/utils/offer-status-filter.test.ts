import { describe, expect, it } from 'vitest';

import {
  isOfferModel,
  OFFER_STATUS_TABS,
  readStatusTab,
  withStatusTab,
} from './offer-status-filter';

const statusClause = (value: string) => ({ contentStatus: { $eq: value } });
const titleClause = { title: { $containsi: 'flipkart' } };

describe('isOfferModel', () => {
  it('claims only the two lifecycle content types', () => {
    expect(isOfferModel('api::coupon.coupon')).toBe(true);
    expect(isOfferModel('api::deal.deal')).toBe(true);
    expect(isOfferModel('api::store.store')).toBe(false);
    expect(isOfferModel(undefined)).toBe(false);
  });
});

describe('readStatusTab', () => {
  it('reads All when nothing filters on status', () => {
    expect(readStatusTab(undefined)).toBe('all');
    expect(readStatusTab({})).toBe('all');
    expect(readStatusTab({ $and: [titleClause] })).toBe('all');
  });

  it('reads the tab back from a status clause', () => {
    for (const tab of ['published', 'scheduled', 'expired'] as const) {
      expect(readStatusTab({ $and: [statusClause(tab)] })).toBe(tab);
    }
  });

  it('finds the status clause alongside hand-built filters', () => {
    expect(
      readStatusTab({ $and: [titleClause, statusClause('expired')] })
    ).toBe('expired');
  });

  // A chip the tabs did not write must not light one up — otherwise "All" would
  // read as selected while the list is plainly narrowed.
  it('selects no tab for a status filter the tabs cannot express', () => {
    expect(readStatusTab({ $and: [{ contentStatus: { $ne: 'expired' } }] })).toBe(null);
    expect(readStatusTab({ $and: [statusClause('draft')] })).toBe(null);
    expect(
      readStatusTab({ $and: [statusClause('published'), statusClause('expired')] })
    ).toBe(null);
  });
});

describe('withStatusTab', () => {
  it('adds a status clause for a concrete tab', () => {
    expect(withStatusTab(undefined, 'published')).toEqual({
      $and: [statusClause('published')],
    });
  });

  it('swaps the existing status clause instead of stacking one', () => {
    expect(withStatusTab({ $and: [statusClause('published')] }, 'expired')).toEqual({
      $and: [statusClause('expired')],
    });
  });

  it('preserves every filter the editor set by hand', () => {
    expect(
      withStatusTab({ $and: [titleClause, statusClause('published')] }, 'scheduled')
    ).toEqual({ $and: [titleClause, statusClause('scheduled')] });
  });

  it('drops only the status clause when returning to All', () => {
    expect(
      withStatusTab({ $and: [titleClause, statusClause('expired')] }, 'all')
    ).toEqual({ $and: [titleClause] });
  });

  // Left as an empty `$and`, the key would linger in the URL as `filters[$and]=`.
  it('returns undefined when All leaves nothing to filter on', () => {
    expect(withStatusTab({ $and: [statusClause('expired')] }, 'all')).toBeUndefined();
    expect(withStatusTab(undefined, 'all')).toBeUndefined();
  });

  it('keeps non-$and filter keys untouched', () => {
    expect(withStatusTab({ $or: [titleClause] }, 'published')).toEqual({
      $or: [titleClause],
      $and: [statusClause('published')],
    });
    expect(withStatusTab({ $or: [titleClause] }, 'all')).toEqual({
      $or: [titleClause],
    });
  });

  it('round-trips every tab through readStatusTab', () => {
    for (const { id } of OFFER_STATUS_TABS) {
      expect(readStatusTab(withStatusTab({ $and: [titleClause] }, id))).toBe(id);
    }
  });
});
