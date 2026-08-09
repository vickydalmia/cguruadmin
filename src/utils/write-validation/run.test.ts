import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@strapi/strapi';
import { lockDomainsFor, runWriteValidation } from './run';
import {
  COLLECTED_STEPS,
  LOCKED_STEPS,
  MUTATOR_STEPS,
  SIDE_EFFECT_STEPS,
  WRITE_ACTIONS,
  stepApplies,
} from './steps';

const names = (steps: readonly { name: string }[]) => steps.map((s) => s.name);

/**
 * The order of these arrays is load-bearing: several steps mutate the payload
 * for the ones after them (normaliseTextFields must trim before the blank check
 * runs; normaliseCouponTypeFields must clear `code` before the length check
 * reads it). This suite pins the sequence so a future "tidy up" of the registry
 * fails loudly instead of silently changing what a save accepts.
 */
describe('write-validation step order', () => {
  it('runs the mutators in the documented order', () => {
    expect(names(MUTATOR_STEPS)).toEqual([
      'sanitizeRichtextData',
      'normaliseTextFields',
      'normaliseCouponTypeFields',
      'normaliseFestiveOfferFields',
    ]);
  });

  it('runs the collected validators in the documented order', () => {
    expect(names(COLLECTED_STEPS)).toEqual([
      'validateCouponTypeFields',
      'validateChangedFields',
      'warnUndersizedSeoOgImage',
      'validateHomepageImages',
      'validateHomepagePopularSearches',
      'validateMenuCategorySections',
      'validateMenuNotification',
      'validateDealOfTheDaySectionLimits',
      'validateIndependenceDaySale',
      'validateContentManagerOfferStore',
      'validateCheckoutMerchantForWrite',
      'validateCloneRelationTargets',
      'validateEntityTopPickCoupons',
      'validateEntityOrderedCoupons',
      'validateOfferFieldsForWrite',
      'validateEntityFieldsForWrite',
      'validateEntityDealPageSeo',
      'validateOfferLifecycle',
      'validateTextFieldsForWrite',
    ]);
  });

  it('keeps cross-row checks together under the lock', () => {
    expect(names(LOCKED_STEPS)).toEqual([
      'validateIdentity',
      'validateRedirect',
      'validateJobSlug',
      'revalidateCheckoutMerchantForWrite',
      'validateOfferAffiliateBrands',
      'validateEntityOfferAffiliateConnections',
    ]);
  });

  it('keeps the paid deal-image step isolated as a side effect', () => {
    expect(names(SIDE_EFFECT_STEPS)).toEqual(['ensureTransparentDealImageForWrite']);
  });

  it('gives every step a unique name', () => {
    const all = names([
      ...MUTATOR_STEPS,
      ...COLLECTED_STEPS,
      ...LOCKED_STEPS,
      ...SIDE_EFFECT_STEPS,
    ]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('stepApplies', () => {
  const step = (name: string) =>
    [...MUTATOR_STEPS, ...COLLECTED_STEPS, ...LOCKED_STEPS, ...SIDE_EFFECT_STEPS].find(
      (candidate) => candidate.name === name,
    )!;

  it('defaults to the three write actions', () => {
    for (const action of WRITE_ACTIONS) {
      expect(stepApplies(step('validateChangedFields'), 'api::store.store', action)).toBe(
        true,
      );
    }
  });

  it('never runs a validator for delete / publish / unpublish / discardDraft', () => {
    // These reach the middleware (DOCUMENT_WRITE_ACTIONS) but carry no editable
    // payload, and never ran a validator before this refactor either.
    for (const action of ['delete', 'publish', 'unpublish', 'discardDraft']) {
      for (const candidate of [...MUTATOR_STEPS, ...COLLECTED_STEPS, ...LOCKED_STEPS]) {
        expect(stepApplies(candidate, 'api::store.store', action)).toBe(false);
      }
    }
  });

  it('keeps the create/update-only steps off clone', () => {
    // Homepage images, Deal of the Day limits and top-pick coupons have always
    // been create/update only. Widening them to clone would be a silent
    // behaviour change.
    expect(stepApplies(step('validateHomepageImages'), 'api::homepage.homepage', 'clone')).toBe(
      false,
    );
    expect(stepApplies(step('validateHomepageImages'), 'api::homepage.homepage', 'update')).toBe(
      true,
    );
    expect(
      stepApplies(step('validateEntityTopPickCoupons'), 'api::store.store', 'clone'),
    ).toBe(false);
    expect(
      stepApplies(step('validateEntityOrderedCoupons'), 'api::store.store', 'clone'),
    ).toBe(false);
    expect(
      stepApplies(
        step('validateDealOfTheDaySectionLimits'),
        'api::deal-of-the-day-page.deal-of-the-day-page',
        'clone',
      ),
    ).toBe(false);
  });

  it('scopes uid-specific steps to their own content types', () => {
    // Both offer schemas carry couponType + uniqueCouponPool, so both are in
    // scope; a non-offer type is not.
    expect(stepApplies(step('validateCouponTypeFields'), 'api::coupon.coupon', 'update')).toBe(
      true,
    );
    expect(stepApplies(step('validateCouponTypeFields'), 'api::deal.deal', 'update')).toBe(
      true,
    );
    expect(stepApplies(step('validateCouponTypeFields'), 'api::store.store', 'update')).toBe(
      false,
    );

    expect(
      stepApplies(step('ensureTransparentDealImageForWrite'), 'api::deal.deal', 'update'),
    ).toBe(true);
    expect(
      stepApplies(step('ensureTransparentDealImageForWrite'), 'api::coupon.coupon', 'update'),
    ).toBe(false);

    expect(stepApplies(step('validateOfferFieldsForWrite'), 'api::deal.deal', 'update')).toBe(
      true,
    );
    expect(stepApplies(step('validateOfferFieldsForWrite'), 'api::store.store', 'update')).toBe(
      false,
    );

    expect(
      stepApplies(
        step('validateContentManagerOfferStore'),
        'api::coupon.coupon',
        'clone',
      ),
    ).toBe(true);
    expect(
      stepApplies(
        step('validateContentManagerOfferStore'),
        'api::store.store',
        'update',
      ),
    ).toBe(false);
  });

  it('runs the unguarded steps for every content type', () => {
    // validateIdentity / validateRedirect deliberately run for all uids and
    // no-op internally on a type they do not own — unchanged from the original
    // middleware, which also called both unconditionally.
    for (const name of ['validateIdentity', 'validateRedirect', 'validateTextFieldsForWrite']) {
      expect(stepApplies(step(name), 'api::job.job', 'update')).toBe(true);
      expect(stepApplies(step(name), 'api::redirect.redirect', 'create')).toBe(true);
    }
  });
});

/**
 * A strapi stub carrying a request context and an empty database.
 *
 * `human` drives isHumanWrite, and therefore the "clean as you touch" strict
 * flag — the one piece of middleware state the extracted pipeline still has to
 * compute for itself.
 *
 * Reads return nothing: no stored row, no name/slug collision. That is enough
 * for group C to clear a valid record, and it keeps every assertion below about
 * the payload rather than about fixture data.
 */
const fakeStrapi = ({ human }: { human: boolean }): Core.Strapi =>
  ({
    requestContext: { get: () => (human ? ({ state: {} } as any) : undefined) },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    documents: () => ({
      findOne: async () => null,
      findMany: async () => [],
      count: async () => 0,
    }),
    db: {
      query: () => ({
        findOne: async () => null,
        findMany: async () => [],
        count: async () => 0,
      }),
      // No knex client → acquireWriteSerializationLock is a no-op, which is
      // exactly what happens on SQLite.
      connection: undefined,
    },
  }) as unknown as Core.Strapi;

const write = (uid: string, data: any, action = 'create') => ({
  uid,
  action,
  params: { data },
});

const caught = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    return error as Error & { details?: { errors?: { path: string[] }[] } };
  }
  throw new Error('expected runWriteValidation to throw');
};

describe('runWriteValidation — one save reports every problem', () => {
  it('merges problems from validators that used to hide each other', async () => {
    // THE BUG THIS FIXES. `slug` is caught by changed-field-validation and
    // `logoAlt` by text-field-validation. They are the 2nd and 9th collected
    // steps, so before this pipeline existed the slug error aborted the request
    // and the editor never learned about the blank alt text until the next save.
    const error = await caught(() =>
      runWriteValidation(
        fakeStrapi({ human: true }),
        write('api::store.store', {
          name: 'Amazon',
          slug: 'Bad_Slug',
          shortDescription: 'x'.repeat(200),
          logo: { documentId: 'logo-1' },
          logoAlt: '   ',
          seo: { metaTitle: 'Amazon', metaDescription: 'Amazon offers.' },
        }),
      ),
    );

    const paths = error.details?.errors?.map((e) => e.path.join('.'));
    expect(paths).toContain('slug');
    expect(paths).toContain('logoAlt');
    expect(error.message).toContain('has 2 problems');
  });

  it('reports a third validator in the same save', async () => {
    // shortDescription (min 160) and slug both come from changed-field
    // validation; logoAlt from text-field validation. All three, one save.
    const error = await caught(() =>
      runWriteValidation(
        fakeStrapi({ human: true }),
        write('api::store.store', {
          name: 'Amazon',
          slug: 'Bad_Slug',
          shortDescription: 'Too short.',
          logo: { documentId: 'logo-1' },
          logoAlt: '',
          seo: { metaTitle: 'Amazon', metaDescription: 'Amazon offers.' },
        }),
      ),
    );

    const paths = error.details?.errors?.map((e) => e.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['slug', 'shortDescription', 'logoAlt']),
    );
  });

  it('resolves quietly and takes no lock when the record is valid', async () => {
    // Group C runs for every uid and no-ops on a type it does not own, so a
    // valid store on a non-Postgres connection returns a null lock handle.
    const release = await runWriteValidation(
      fakeStrapi({ human: true }),
      write('api::store.store', {
        name: 'Amazon',
        slug: 'amazon',
        shortDescription: 'x'.repeat(200),
        logo: { documentId: 'logo-1' },
        logoAlt: 'Amazon logo',
        seo: { metaTitle: 'Amazon', metaDescription: 'Amazon offers.' },
      }),
    );

    expect(release).toBeNull();
  });

  it('normalises the payload before validating it', async () => {
    // The mutators must run first: "  Amazon   Pay " is trimmed and collapsed,
    // so the required check sees a real value and the stored name is clean.
    const data: any = {
      name: '  Amazon   Pay ',
      slug: 'amazon',
      shortDescription: 'x'.repeat(200),
      logo: { documentId: 'logo-1' },
      logoAlt: 'Amazon logo',
      seo: { metaTitle: 'Amazon', metaDescription: 'Amazon offers.' },
    };

    await runWriteValidation(fakeStrapi({ human: true }), write('api::store.store', data));

    expect(data.name).toBe('Amazon Pay');
  });

  it('skips validators for actions with no editable payload', async () => {
    const strapi = fakeStrapi({ human: true });
    for (const action of ['publish', 'unpublish', 'discardDraft']) {
      await expect(
        runWriteValidation(strapi, write('api::store.store', {}, action)),
      ).resolves.toBeNull();
    }
    // Delete is asserted on a NON-affiliate uid: Store/Brand deletes now
    // deliberately return the affiliate lock release (see the test below), so
    // the null contract only holds for types outside that rule.
    await expect(
      runWriteValidation(strapi, write('api::category.category', {}, 'delete')),
    ).resolves.toBeNull();
  });

  it('holds the fail-closed affiliate lock across a Store delete', async () => {
    const strapi: any = fakeStrapi({ human: false });
    const trx = {
      raw: vi.fn(async () => ({})),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };
    strapi.db.connection = {
      client: { config: { client: 'postgres' } },
      transaction: vi.fn(async () => trx),
    };

    const release = await runWriteValidation(
      strapi,
      write('api::store.store', undefined, 'delete'),
    );
    expect(release).toBeTypeOf('function');
    const lockCalls = trx.raw.mock.calls.filter(([sql]) =>
      String(sql).includes('pg_advisory_xact_lock'),
    );
    expect(lockCalls.map(([, params]) => params?.[1])).toEqual(['affiliate']);

    await release!();
    expect(trx.commit).toHaveBeenCalledTimes(1);
  });

  it('rechecks a touched checkout merchant after reaching the locked pass', async () => {
    const strapi: any = fakeStrapi({ human: false });
    const unrelatedSteps = COLLECTED_STEPS.filter(
      ({ name }) => name !== 'validateCheckoutMerchantForWrite',
    ).map((step) => vi.spyOn(step, 'run').mockResolvedValue(undefined));
    let merchantReads = 0;
    strapi.documents = (uid: string) => ({
      findOne: async () => {
        if (uid !== 'api::store.store') return null;
        merchantReads += 1;
        return merchantReads === 1 ? { name: 'Live Store' } : null;
      },
      findMany: async () => [],
      count: async () => 0,
    });

    try {
      const error = await caught(() =>
        runWriteValidation(
          strapi,
          write(
            'api::coupon.coupon',
            { checkoutMerchant: 'store:store-1' },
            'update',
          ),
        ),
      );
      expect(merchantReads).toBe(2);
      expect(error.details?.errors?.map(({ path }) => path)).toContainEqual([
        'checkoutMerchant',
      ]);
    } finally {
      for (const spy of unrelatedSteps) spy.mockRestore();
    }
  });

  it('lets a genuine bug propagate instead of reporting it as a field problem', async () => {
    // A TypeError from inside a validator is not an editor-facing verdict; it
    // must still surface as the 500 it always was.
    const bug = new TypeError('boom');
    const strapi = fakeStrapi({ human: true });
    const spy = vi
      .spyOn(COLLECTED_STEPS[1], 'run')
      .mockImplementation(() => {
        throw bug;
      });

    try {
      await expect(
        runWriteValidation(strapi, write('api::store.store', { name: 'Amazon' })),
      ).rejects.toBe(bug);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runWriteValidation — the cron stays grandfathered', () => {
  it('does not enforce untouched fields on a non-human partial write', async () => {
    // The 5-minute contentStatus cron has no HTTP request context, so strict is
    // false and a partial payload over a dirty legacy row must still save.
    // If this regresses, the cron starts throwing on WordPress-migrated rows.
    await expect(
      runWriteValidation(
        fakeStrapi({ human: false }),
        write('api::store.store', { ratingCount: 12 }, 'update'),
      ),
    ).resolves.toBeNull();
  });

  it('would reject the same partial write from a human', async () => {
    // Same payload, human origin → "clean as you touch" turns on and the
    // untouched required fields are enforced. This is the pairing that proves
    // `strict` is still threaded through the extracted pipeline.
    const error = await caught(() =>
      runWriteValidation(
        fakeStrapi({ human: true }),
        write('api::store.store', { ratingCount: 12 }, 'update'),
      ),
    );

    expect(error.details?.errors?.length).toBeGreaterThan(0);
  });
});

describe('lockDomainsFor', () => {
  it('locks every brand save on affiliate + identity', () => {
    expect(lockDomainsFor('api::brand.brand', { name: 'Nike' }, 'update')).toEqual([
      'affiliate',
      'identity',
    ]);
  });

  it('locks a store save touching its offer inverses on affiliate + identity', () => {
    expect(
      lockDomainsFor('api::store.store', { coupons: { connect: [1] } }, 'update'),
    ).toEqual(['affiliate', 'identity']);
    expect(
      lockDomainsFor('api::store.store', { deals: [] }, 'update'),
    ).toEqual(['affiliate', 'identity']);
  });

  it('locks a store CLONE on affiliate + identity even with no payload', () => {
    // The clone inherits the source's coupons/deals connections without the
    // payload ever naming them.
    expect(lockDomainsFor('api::store.store', undefined, 'clone')).toEqual([
      'affiliate',
      'identity',
    ]);
  });

  it('locks Store and Brand deletion on affiliate ONLY', () => {
    // The delete clears checkoutMerchant references (affiliate domain); it
    // FREES identifiers, so there is no uniqueness race for identity to
    // serialize — and holding the hottest domain fail-closed across a
    // delete's relation cascade would reject concurrent taxonomy saves.
    expect(lockDomainsFor('api::store.store', undefined, 'delete')).toEqual([
      'affiliate',
    ]);
    expect(lockDomainsFor('api::brand.brand', undefined, 'delete')).toEqual([
      'affiliate',
    ]);
    // Non-affiliate deletes take no lock at all.
    expect(lockDomainsFor('api::category.category', undefined, 'delete')).toEqual(
      [],
    );
    expect(lockDomainsFor('api::coupon.coupon', undefined, 'delete')).toEqual([]);
  });

  it('locks a plain store/category save on identity only', () => {
    expect(lockDomainsFor('api::store.store', { name: 'Amazon' }, 'update')).toEqual([
      'identity',
    ]);
    expect(
      lockDomainsFor('api::category.category', { name: 'Travel' }, 'create'),
    ).toEqual(['identity']);
  });

  it('locks offers on affiliate when the payload touches affiliate fields or clones', () => {
    expect(
      lockDomainsFor('api::coupon.coupon', { checkoutMerchant: 'brand:x' }, 'update'),
    ).toEqual(['affiliate']);
    expect(lockDomainsFor('api::deal.deal', undefined, 'clone')).toEqual([
      'affiliate',
    ]);
    expect(
      lockDomainsFor('api::coupon.coupon', { contentStatus: 'expired' }, 'update'),
    ).toEqual([]);
  });

  it('keeps redirect and job on their own domains', () => {
    expect(lockDomainsFor('api::redirect.redirect', {}, 'update')).toEqual([
      'redirect',
    ]);
    expect(lockDomainsFor('api::job.job', {}, 'create')).toEqual(['job']);
  });

  it('never emits identity before affiliate (fixed acquisition order)', () => {
    // Every caller must list multi-domain sets in the same order, or two
    // saves could deadlock waiting on each other's held lock.
    const samples = [
      lockDomainsFor('api::brand.brand', {}, 'update'),
      lockDomainsFor('api::store.store', { coupons: [] }, 'update'),
      lockDomainsFor('api::store.store', undefined, 'clone'),
    ];
    for (const domains of samples) {
      const affiliateIndex = domains.indexOf('affiliate');
      const identityIndex = domains.indexOf('identity');
      expect(affiliateIndex).toBe(0);
      expect(identityIndex).toBe(1);
    }
  });
});
