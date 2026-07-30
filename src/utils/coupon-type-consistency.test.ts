import { describe, expect, it, vi } from 'vitest';
import {
  isCouponUid,
  normaliseCouponTypeFields,
  validateCouponTypeFields,
} from './coupon-type-consistency';

const COUPON_UID = 'api::coupon.coupon' as const;
const DEAL_UID = 'api::deal.deal' as const;

describe('normaliseCouponTypeFields', () => {
  describe('couponType absent from the payload (cron safety)', () => {
    // THE critical case. config/cron-tasks.ts runs every 5 minutes and issues
    // update({ data: { contentStatus } }) with no couponType. Clearing on
    // absence would detach the pool from every scheduled unique coupon it
    // touches.
    it('leaves a cron contentStatus-only payload completely untouched', () => {
      const data = { contentStatus: 'published' };

      const result = normaliseCouponTypeFields(data);

      expect(result).toEqual({ contentStatus: 'published' });
      expect('uniqueCouponPool' in result).toBe(false);
      expect('code' in result).toBe(false);
    });

    it('leaves the cron contentStatus + scheduledAt payload untouched', () => {
      const data = { contentStatus: 'published', scheduledAt: null };

      const result = normaliseCouponTypeFields(data);

      expect(result).toEqual({ contentStatus: 'published', scheduledAt: null });
      expect('uniqueCouponPool' in result).toBe(false);
      expect('code' in result).toBe(false);
    });

    it('does NOT detach an explicitly-passed pool when couponType is absent', () => {
      const data = { contentStatus: 'expired', uniqueCouponPool: 42 };

      const result = normaliseCouponTypeFields(data);

      expect(result.uniqueCouponPool).toBe(42);
    });

    it('does NOT clear an explicitly-passed code when couponType is absent', () => {
      const data = { contentStatus: 'expired', code: 'SAVE20' };

      const result = normaliseCouponTypeFields(data);

      expect(result.code).toBe('SAVE20');
    });

    it('no-ops on an empty partial payload', () => {
      expect(normaliseCouponTypeFields({})).toEqual({});
    });
  });

  describe('couponType === "static"', () => {
    it('clears uniqueCouponPool', () => {
      const data = { couponType: 'static', uniqueCouponPool: 7 };

      const result = normaliseCouponTypeFields(data);

      expect(result.uniqueCouponPool).toBeNull();
    });

    it('clears uniqueCouponPool even when the admin omitted it (hidden field)', () => {
      // The admin hides uniqueCouponPool when static and drops it from the PUT
      // body, so the stored value survives — this is the bug row 57 fixes.
      const data: Record<string, unknown> = { couponType: 'static', code: 'SAVE20' };

      const result = normaliseCouponTypeFields(data);

      expect(result.uniqueCouponPool).toBeNull();
    });

    it('keeps the code, which is the relevant field for a static coupon', () => {
      const data = { couponType: 'static', code: 'SAVE20', uniqueCouponPool: 7 };

      const result = normaliseCouponTypeFields(data);

      expect(result.code).toBe('SAVE20');
      expect(result.uniqueCouponPool).toBeNull();
    });
  });

  describe('couponType === "unique"', () => {
    it('clears code', () => {
      const data = { couponType: 'unique', code: 'LEGACY10' };

      const result = normaliseCouponTypeFields(data);

      expect(result.code).toBeNull();
    });

    it('clears code even when the admin omitted it (hidden field)', () => {
      const data: Record<string, unknown> = { couponType: 'unique', uniqueCouponPool: 7 };

      const result = normaliseCouponTypeFields(data);

      expect(result.code).toBeNull();
    });

    it('keeps uniqueCouponPool, the relevant field for a unique coupon', () => {
      const data = { couponType: 'unique', code: 'LEGACY10', uniqueCouponPool: 7 };

      const result = normaliseCouponTypeFields(data);

      expect(result.uniqueCouponPool).toBe(7);
      expect(result.code).toBeNull();
    });
  });

  describe('couponType present but unreadable', () => {
    // Present-but-unusable must behave like absent: an unreadable type is not
    // a licence to delete a field.
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['unrecognised string', 'bogus'],
      ['number', 3],
    ])('no-ops when couponType is %s', (_label, couponType) => {
      const data = { couponType, code: 'SAVE20', uniqueCouponPool: 7 };

      const result = normaliseCouponTypeFields(data);

      expect(result.code).toBe('SAVE20');
      expect(result.uniqueCouponPool).toBe(7);
    });

    it('treats an explicit undefined couponType as present-but-unreadable, not as a type change', () => {
      const data: Record<string, unknown> = { couponType: undefined, uniqueCouponPool: 7 };

      const result = normaliseCouponTypeFields(data);

      expect(result.uniqueCouponPool).toBe(7);
    });
  });

  describe('non-object payloads', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'static'],
      ['a number', 1],
    ])('returns %s unchanged', (_label, input) => {
      expect(normaliseCouponTypeFields(input as never)).toBe(input);
    });
  });

  describe('mutation contract', () => {
    it('mutates in place so the caller can pass context.params.data directly', () => {
      const data = { couponType: 'static', uniqueCouponPool: 7 };

      const result = normaliseCouponTypeFields(data);

      expect(result).toBe(data);
      expect(data.uniqueCouponPool).toBeNull();
    });

    it('adds no keys beyond the one it clears', () => {
      const data = { couponType: 'unique', title: 'Flat 50% off' };

      const result = normaliseCouponTypeFields(data);

      expect(Object.keys(result).sort()).toEqual(['code', 'couponType', 'title']);
    });
  });
});

describe('isCouponUid', () => {
  // Both offer schemas carry couponType + uniqueCouponPool, so both need the
  // same normaliser and the same "unique needs a pool" check.
  it.each([[COUPON_UID], [DEAL_UID]])('matches %s', (uid) => {
    expect(isCouponUid(uid)).toBe(true);
  });

  it.each([['api::store.store'], ['api::homepage.homepage'], [''], [undefined], [null]])(
    'rejects %s',
    (uid) => {
      expect(isCouponUid(uid)).toBe(false);
    },
  );
});

describe('validateCouponTypeFields', () => {
  function harness(stored: unknown = null) {
    const findOne = vi.fn().mockResolvedValue(stored);
    return {
      strapi: { documents: vi.fn(() => ({ findOne })) } as any,
      findOne,
    };
  }

  it.each(['create', 'clone'])(
    'requires a pool when a %s produces a unique coupon',
    async (action) => {
      const { strapi } = harness();
      await expect(
        validateCouponTypeFields(strapi, COUPON_UID, action, {
          couponType: 'unique',
          uniqueCouponPool: null,
        }),
      ).rejects.toMatchObject({
        name: 'ValidationError',
        details: {
          errors: [
            expect.objectContaining({ path: ['uniqueCouponPool'] }),
          ],
        },
      });
    },
  );

  it('accepts a unique coupon with a direct or connect-patch pool', async () => {
    const { strapi } = harness();
    await expect(
      validateCouponTypeFields(strapi, COUPON_UID, 'create', {
        couponType: 'unique',
        uniqueCouponPool: { documentId: 'pool-1' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateCouponTypeFields(strapi, COUPON_UID, 'create', {
        couponType: 'unique',
        uniqueCouponPool: { connect: [{ documentId: 'pool-1' }] },
      }),
    ).resolves.toBeUndefined();
  });

  it('allows a static coupon without a code or pool', async () => {
    const { strapi } = harness();
    await expect(
      validateCouponTypeFields(strapi, COUPON_UID, 'create', {
        couponType: 'static',
        code: null,
        uniqueCouponPool: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects changing a stored static coupon to unique without a pool', async () => {
    const { strapi } = harness({
      couponType: 'static',
      uniqueCouponPool: null,
    });
    await expect(
      validateCouponTypeFields(
        strapi,
        COUPON_UID,
        'update',
        { couponType: 'unique', uniqueCouponPool: null },
        'coupon-1',
      ),
    ).rejects.toThrow(/Choose a Unique Coupon Pool/);
  });

  it('rejects disconnecting the pool from a valid unique coupon', async () => {
    const { strapi } = harness({
      couponType: 'unique',
      uniqueCouponPool: { documentId: 'pool-1' },
    });
    await expect(
      validateCouponTypeFields(
        strapi,
        COUPON_UID,
        'update',
        {
          couponType: 'unique',
          uniqueCouponPool: {
            disconnect: [{ documentId: 'pool-1' }],
          },
        },
        'coupon-1',
      ),
    ).rejects.toThrow(/Choose a Unique Coupon Pool/);
  });

  it('grandfathers a full-form re-save of an existing poolless unique coupon', async () => {
    const { strapi } = harness({
      couponType: 'unique',
      uniqueCouponPool: null,
    });
    await expect(
      validateCouponTypeFields(
        strapi,
        COUPON_UID,
        'update',
        {
          title: 'Edited title',
          couponType: 'unique',
          uniqueCouponPool: null,
        },
        'coupon-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts an empty clone that inherits a valid unique pool', async () => {
    const { strapi, findOne } = harness({
      couponType: 'unique',
      uniqueCouponPool: { documentId: 'pool-1' },
    });
    await expect(
      validateCouponTypeFields(strapi, COUPON_UID, 'clone', {}, 'coupon-1'),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'coupon-1' }),
    );
  });

  it('rejects a clone override that disconnects the inherited unique pool', async () => {
    const { strapi } = harness({
      couponType: 'unique',
      uniqueCouponPool: { documentId: 'pool-1' },
    });
    await expect(
      validateCouponTypeFields(
        strapi,
        COUPON_UID,
        'clone',
        {
          uniqueCouponPool: {
            disconnect: [{ documentId: 'pool-1' }],
          },
        },
        'coupon-1',
      ),
    ).rejects.toThrow(/Choose a Unique Coupon Pool/);
  });

  it('does not grandfather an invalid poolless source into a new clone', async () => {
    const { strapi } = harness({
      couponType: 'unique',
      uniqueCouponPool: null,
    });
    await expect(
      validateCouponTypeFields(strapi, COUPON_UID, 'clone', {}, 'coupon-1'),
    ).rejects.toThrow(/Choose a Unique Coupon Pool/);
  });

  it('does not query for a partial cron update', async () => {
    const { strapi, findOne } = harness({
      couponType: 'unique',
      uniqueCouponPool: null,
    });
    await validateCouponTypeFields(
      strapi,
      COUPON_UID,
      'update',
      { contentStatus: 'expired' },
      'coupon-1',
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  describe('STRICT clean-as-you-touch', () => {
    it('blocks a human save on a dirty untouched poolless unique coupon (strict)', async () => {
      // Editor touches only `title`; the stored row is an already-invalid
      // poolless unique coupon. Grandfathering lets this through — strict must
      // enforce the whole effective record and reject.
      const { strapi } = harness({ couponType: 'unique', uniqueCouponPool: null });

      await expect(
        validateCouponTypeFields(
          strapi,
          COUPON_UID,
          'update',
          { title: 'Renamed' },
          'coupon-1',
          true,
        ),
      ).rejects.toMatchObject({
        name: 'ValidationError',
        details: {
          errors: [expect.objectContaining({ path: ['uniqueCouponPool'] })],
        },
      });
    });

    it('lets the cron pass the same dirty untouched poolless unique coupon (strict=false)', async () => {
      const { strapi } = harness({ couponType: 'unique', uniqueCouponPool: null });

      await expect(
        validateCouponTypeFields(
          strapi,
          COUPON_UID,
          'update',
          { title: 'Renamed' },
          'coupon-1',
          false,
        ),
      ).resolves.toBeUndefined();
    });

    it('blocks a strict save that touches neither type nor pool on a dirty row', async () => {
      // No couponType and no uniqueCouponPool in the payload — the cron-safety
      // early bail. Strict must not take that bail on a human save.
      const { strapi, findOne } = harness({ couponType: 'unique', uniqueCouponPool: null });

      await expect(
        validateCouponTypeFields(
          strapi,
          COUPON_UID,
          'update',
          { contentStatus: 'published' },
          'coupon-1',
          true,
        ),
      ).rejects.toThrow(/Choose a Unique Coupon Pool/);
      expect(findOne).toHaveBeenCalled();
    });

    it('passes a strict save when the effective record is clean', async () => {
      const { strapi } = harness({
        couponType: 'unique',
        uniqueCouponPool: { documentId: 'pool-1' },
      });

      await expect(
        validateCouponTypeFields(
          strapi,
          COUPON_UID,
          'update',
          { title: 'Renamed' },
          'coupon-1',
          true,
        ),
      ).resolves.toBeUndefined();
    });

    it('lets a strict editor repair the dirty row by attaching a pool', async () => {
      const { strapi } = harness({ couponType: 'unique', uniqueCouponPool: null });

      await expect(
        validateCouponTypeFields(
          strapi,
          COUPON_UID,
          'update',
          { uniqueCouponPool: { connect: [{ documentId: 'pool-1' }] } },
          'coupon-1',
          true,
        ),
      ).resolves.toBeUndefined();
    });
  });
});

describe('unique pools on Product Deals', () => {
  function harness(stored: unknown = null) {
    const documents = vi.fn(() => ({
      findOne: vi.fn().mockResolvedValue(stored),
    }));
    return { strapi: { documents } as any, documents };
  }

  it('requires a pool when a Deal is saved as unique', async () => {
    const { strapi } = harness();

    await expect(
      validateCouponTypeFields(strapi, DEAL_UID, 'create', {
        couponType: 'unique',
        uniqueCouponPool: null,
      }),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      details: {
        errors: [expect.objectContaining({ path: ['uniqueCouponPool'] })],
      },
    });
  });

  it('reads the merge base from the Deal schema, not the Coupon one', async () => {
    // The uid used to be hard-coded, so validating a Deal would have gone
    // looking for it among Coupons and found nothing.
    const { strapi, documents } = harness({
      documentId: 'deal-1',
      couponType: 'unique',
      uniqueCouponPool: { documentId: 'pool-1' },
    });

    await expect(
      validateCouponTypeFields(strapi, DEAL_UID, 'update', { title: 'Edited' }, 'deal-1', true),
    ).resolves.toBeUndefined();
    expect(documents).toHaveBeenCalledWith(DEAL_UID);
  });

  it('clears a Deal code when it becomes unique, and the pool when it becomes static', () => {
    // Same mutual exclusion the Coupon schema has: the admin hides the losing
    // field, so it is omitted from the payload and the stored value survives
    // unless something clears it.
    expect(
      normaliseCouponTypeFields({ couponType: 'unique', code: 'OLD' }),
    ).toMatchObject({ code: null });
    expect(
      normaliseCouponTypeFields({ couponType: 'static', uniqueCouponPool: 'pool-1' }),
    ).toMatchObject({ uniqueCouponPool: null });
  });
});
