import { describe, expect, it } from 'vitest';

import {
  FESTIVE_OFFER_FIELDS,
  isFestiveOfferUid,
  normaliseFestiveOfferFields,
} from './festive-offer-consistency';

const filled = () => ({
  isFestiveOffer: true,
  festiveOfferTitle: 'Diwali Dhamaka',
  festiveOfferDescription: '<p>Up to 70% off</p>',
});

describe('isFestiveOfferUid', () => {
  it('matches only store and brand', () => {
    expect(isFestiveOfferUid('api::store.store')).toBe(true);
    expect(isFestiveOfferUid('api::brand.brand')).toBe(true);
    expect(isFestiveOfferUid('api::category.category')).toBe(false);
    expect(isFestiveOfferUid('api::bank.bank')).toBe(false);
    expect(isFestiveOfferUid('api::coupon.coupon')).toBe(false);
    expect(isFestiveOfferUid(undefined)).toBe(false);
  });
});

describe('normaliseFestiveOfferFields', () => {
  it('leaves a payload that never mentions the toggle byte-identical', () => {
    // The load-bearing guard. A partial write (import, scripted update) that
    // says nothing about the toggle must not wipe a live festive offer.
    const data = { name: 'Nike', festiveOfferTitle: 'Diwali Dhamaka' };
    expect(normaliseFestiveOfferFields(data)).toEqual({
      name: 'Nike',
      festiveOfferTitle: 'Diwali Dhamaka',
    });
  });

  it('keeps both fields when the toggle is on', () => {
    expect(normaliseFestiveOfferFields(filled())).toEqual(filled());
  });

  it('clears both fields when the toggle is switched off', () => {
    expect(
      normaliseFestiveOfferFields({ ...filled(), isFestiveOffer: false }),
    ).toEqual({
      isFestiveOffer: false,
      festiveOfferTitle: null,
      festiveOfferDescription: null,
    });
  });

  it('clears the fields the admin OMITTED when the toggle goes off', () => {
    // The real shape of the failing save: `conditions.visible` hides both
    // fields the moment the toggle flips, and the admin strips hidden paths
    // out of the PUT body — so the payload carries the toggle alone and the
    // stored values would otherwise survive invisibly.
    expect(normaliseFestiveOfferFields({ isFestiveOffer: false })).toEqual({
      isFestiveOffer: false,
      festiveOfferTitle: null,
      festiveOfferDescription: null,
    });
  });

  it('treats a null or undefined toggle as off', () => {
    // The schema default is false, so an explicitly unset toggle is not a
    // festive offer and must not keep festive content alive.
    for (const isFestiveOffer of [null, undefined]) {
      expect(
        normaliseFestiveOfferFields({ ...filled(), isFestiveOffer }),
      ).toMatchObject({
        festiveOfferTitle: null,
        festiveOfferDescription: null,
      });
    }
  });

  it('mutates in place and returns the same object', () => {
    // Same in-place contract as sanitizeRichtextData — the pipeline's later
    // steps read context.params.data, not this return value.
    const data = { ...filled(), isFestiveOffer: false };
    expect(normaliseFestiveOfferFields(data)).toBe(data);
    expect(data.festiveOfferTitle).toBeNull();
  });

  it('ignores null / non-object data', () => {
    expect(normaliseFestiveOfferFields(null)).toBeNull();
    expect(normaliseFestiveOfferFields('nope')).toBe('nope');
  });

  it('covers every field the toggle owns', () => {
    const data: Record<string, unknown> = { isFestiveOffer: false };
    for (const field of FESTIVE_OFFER_FIELDS) data[field] = 'something';
    normaliseFestiveOfferFields(data);
    for (const field of FESTIVE_OFFER_FIELDS) {
      expect(data[field]).toBeNull();
    }
  });
});
