import { describe, expect, it, vi } from 'vitest';
import {
  validateOfferFields,
  validateOfferFieldsForWrite,
} from './offer-field-validation';

describe('validateOfferFields', () => {
  it('accepts a valid badge and bare benefit amounts', () => {
    expect(() =>
      validateOfferFields({
        offerText: 'EXTRA 18% OFF', // 3 words
        cashbackText: '15%',
        bankOfferText: '₹2,000',
        prepaidText: 'Rs.100',
      })
    ).not.toThrow();
    expect(() =>
      validateOfferFields({
        cashbackText: '19.2%',
        bankOfferText: '$40',
        prepaidText: 'INR 500',
      })
    ).not.toThrow();
  });

  it('rejects an offerText with more than 3 words', () => {
    expect(() => validateOfferFields({ offerText: 'GET FLAT 50% OFF NOW' })).toThrow(
      /Offer text must be at most 3 words/
    );
  });

  it('rejects benefit texts that carry wording instead of a bare amount', () => {
    expect(() => validateOfferFields({ cashbackText: '15% Cashback' })).toThrow(
      /Cashback text must be an amount only/
    );
    expect(() => validateOfferFields({ bankOfferText: '12% Bank OFF' })).toThrow(
      /Bank offer text must be an amount only/
    );
    expect(() => validateOfferFields({ prepaidText: '5% Prepaid OFF' })).toThrow(
      /Prepaid text must be an amount only/
    );
  });

  it('rejects benefit values that are not amounts at all', () => {
    expect(() => validateOfferFields({ cashbackText: 'Free Shipping' })).toThrow(
      /Cashback text must be an amount only/
    );
    expect(() => validateOfferFields({ bankOfferText: '100' })).toThrow(
      /Bank offer text must be an amount only/
    );
    expect(() => validateOfferFields({ prepaidText: '%' })).toThrow(
      /Prepaid text must be an amount only/
    );
  });

  it('ignores empty, null, and absent fields (partial updates)', () => {
    expect(() => validateOfferFields({ offerText: '', cashbackText: null })).not.toThrow();
    expect(() => validateOfferFields({ title: 'unrelated' })).not.toThrow();
    expect(() => validateOfferFields(null)).not.toThrow();
  });

  it('collects multiple problems in one error', () => {
    try {
      validateOfferFields({
        offerText: 'one two three four',
        bankOfferText: 'a b c d',
      });
      throw new Error('expected validateOfferFields to throw');
    } catch (err: any) {
      expect(err.details?.errors).toHaveLength(2);
      expect(err.details.errors.map((e: any) => e.path[0])).toEqual([
        'offerText',
        'bankOfferText',
      ]);
    }
  });

  it('grandfathers an unchanged over-limit value on update', () => {
    expect(() =>
      validateOfferFields(
        { offerText: 'GET FLAT 50% OFF' },
        'update',
        { offerText: 'GET   FLAT 50% OFF' },
      )
    ).not.toThrow();
  });

  it('still rejects changing one over-limit value to another', () => {
    expect(() =>
      validateOfferFields(
        { offerText: 'GET FLAT 50% OFF NOW' },
        'update',
        { offerText: 'GET FLAT 50% OFF' },
      )
    ).toThrow(/Offer text/);
  });

  it('grandfathers an unchanged legacy full-text benefit value on update', () => {
    // Rows migrated before the amount-only rule store e.g. "15% Cashback";
    // an edit that leaves them untouched must not be blocked.
    expect(() =>
      validateOfferFields(
        { cashbackText: '15% Cashback' },
        'update',
        { cashbackText: '15% Cashback' },
      )
    ).not.toThrow();
    expect(() =>
      validateOfferFields(
        { cashbackText: '20% Cashback' },
        'update',
        { cashbackText: '15% Cashback' },
      )
    ).toThrow(/Cashback text must be an amount only/);
  });
});

describe('validateOfferFieldsForWrite', () => {
  it('reads stored values only for touched offer labels', async () => {
    const findOne = vi.fn().mockResolvedValue({
      offerText: 'GET FLAT 50% OFF',
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateOfferFieldsForWrite(
        strapi,
        'api::coupon.coupon',
        'update',
        { offerText: 'GET FLAT 50% OFF' },
        'coupon-1',
        false,
      ),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'coupon-1',
        fields: ['documentId', 'offerText'],
      }),
    );
  });

  it('does not read on create or an unrelated partial update', async () => {
    const findOne = vi.fn();
    const strapi: any = { documents: () => ({ findOne }) };
    await validateOfferFieldsForWrite(
      strapi,
      'api::deal.deal',
      'create',
      { discount: 'UP TO 50%' },
      undefined,
      false,
    );
    await validateOfferFieldsForWrite(
      strapi,
      'api::deal.deal',
      'update',
      { contentStatus: 'expired' },
      'deal-1',
      false,
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('loads and validates inherited offer labels for an empty clone', async () => {
    const findOne = vi.fn().mockResolvedValue({
      cashbackText: '15%',
      bankOfferText: '₹2000',
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateOfferFieldsForWrite(
        strapi,
        'api::deal.deal',
        'clone',
        {},
        'deal-1',
        false,
      ),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: [
          'documentId',
          'cashbackText',
          'bankOfferText',
          'prepaidText',
        ],
      }),
    );
  });

  it('does not read or validate the removed Product Deal offerText field', async () => {
    const findOne = vi.fn();
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateOfferFieldsForWrite(
        strapi,
        'api::deal.deal',
        'update',
        { offerText: 'LEGACY VALUE WITH TOO MANY WORDS' },
        'deal-1',
        false,
      ),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('does not grandfather an over-limit label into a new clone', async () => {
    const findOne = vi.fn().mockResolvedValue({
      offerText: 'GET FLAT 50% OFF',
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateOfferFieldsForWrite(
        strapi,
        'api::coupon.coupon',
        'clone',
        {},
        'coupon-1',
        false,
      ),
    ).rejects.toThrow(/Offer text/);
  });

  it('STRICT: blocks the save on a dirty UNTOUCHED offer label', async () => {
    // Migrated coupon whose stored bankOfferText carries legacy wording. The
    // editor only touches an unrelated field (title), so bankOfferText is not
    // in the payload — under strict it is still read from the row and rejected.
    const findOne = vi.fn().mockResolvedValue({
      offerText: 'FLAT 50% OFF',
      cashbackText: '15%',
      bankOfferText: 'GET EXTRA 12% BANK OFF',
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateOfferFieldsForWrite(
        strapi,
        'api::coupon.coupon',
        'update',
        { title: 'unrelated edit' },
        'coupon-1',
        true,
      ),
    ).rejects.toThrow(/Bank offer text must be an amount only/);
    // Strict must have read every capped field, not just the touched ones.
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: ['documentId', 'offerText', 'cashbackText', 'bankOfferText', 'prepaidText'],
      }),
    );
  });

  it('NON-strict: the same dirty untouched label passes (cron unaffected)', async () => {
    const findOne = vi.fn().mockResolvedValue({
      offerText: 'FLAT 50% OFF',
      cashbackText: '15%',
      bankOfferText: 'GET EXTRA 12% BANK OFF',
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateOfferFieldsForWrite(
        strapi,
        'api::coupon.coupon',
        'update',
        { contentStatus: 'expired' },
        'coupon-1',
        false,
      ),
    ).resolves.toBeUndefined();
    // Partial cron write touches no capped label, so non-strict never reads.
    expect(findOne).not.toHaveBeenCalled();
  });

  it('STRICT: still rejects an over-limit value the editor left unchanged', async () => {
    // The value IS in the payload but equals the stored (dirty) value — the
    // non-strict grandfather would let it through; strict must not.
    const findOne = vi.fn().mockResolvedValue({
      offerText: 'GET FLAT 50% OFF NOW',
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateOfferFieldsForWrite(
        strapi,
        'api::coupon.coupon',
        'update',
        { offerText: 'GET FLAT 50% OFF NOW' },
        'coupon-1',
        true,
      ),
    ).rejects.toThrow(/Offer text must be at most 3 words/);
  });
});

describe('validateOfferFields — strict flag', () => {
  it('STRICT disables the unchanged-value grandfather', () => {
    expect(() =>
      validateOfferFields(
        { offerText: 'GET FLAT 50% OFF' },
        'update',
        { offerText: 'GET   FLAT 50% OFF' },
        true,
      ),
    ).toThrow(/Offer text/);
  });

  it('NON-strict keeps grandfathering an unchanged over-limit value', () => {
    expect(() =>
      validateOfferFields(
        { offerText: 'GET FLAT 50% OFF' },
        'update',
        { offerText: 'GET   FLAT 50% OFF' },
        false,
      ),
    ).not.toThrow();
  });
});
