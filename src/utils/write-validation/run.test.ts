import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@strapi/strapi';
import { runWriteValidation } from './run';
import { runWithTranslationWriteContext } from '../../translation/write-flag';
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
      'normaliseAffiliateOfferFields',
      'normaliseHomepageHeroOfferFields',
    ]);
  });

  it('runs the collected validators in the documented order', () => {
    expect(names(COLLECTED_STEPS)).toEqual([
      'validateSiteConfigurationForWrite',
      'validateCouponTypeFields',
      'validateChangedFields',
      'warnUndersizedSeoOgImage',
      'validateHomepageImages',
      'validateHomepageHeroOffers',
      'validateHomepagePopularStores',
      'validateHomepagePopularSearches',
      'validateMenuCategorySections',
      'validateMenuNotification',
      'validateDealOfTheDaySectionLimits',
      'validateIndependenceDaySale',
      'validateContentManagerOfferStore',
      'validateAffiliateOfferForWrite',
      'validateAffiliateBrandFlip',
      'validateCheckoutMerchantForWrite',
      'validateOfferCountriesForWrite',
      'validateEntityTopPickCoupons',
      'validateEntityOrderedCoupons',
      'validateOfferFieldsForWrite',
      'validateEntityFieldsForWrite',
      'validateEntityDealPageSeo',
      'validateOfferLifecycle',
      'validateTextFieldsForWrite',
    ]);
  });

  it('keeps cross-row invariants together under the lock', () => {
    expect(names(LOCKED_STEPS)).toEqual([
      'validateIdentity',
      'validateUniqueEntityPageTemplate',
      'validateRedirect',
      'validateJobSlug',
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

  it('checks singleton campaign-template ownership on clone', () => {
    expect(
      stepApplies(step('validateUniqueEntityPageTemplate'), 'api::store.store', 'clone'),
    ).toBe(true);
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

  it('skips the whole pipeline for actions with no editable payload', async () => {
    const strapi = fakeStrapi({ human: true });
    for (const action of ['delete', 'publish', 'unpublish', 'discardDraft']) {
      await expect(
        runWriteValidation(strapi, write('api::store.store', {}, action)),
      ).resolves.toBeNull();
    }
  });

  it('lets a genuine bug propagate instead of reporting it as a field problem', async () => {
    // A TypeError from inside a validator is not an editor-facing verdict; it
    // must still surface as the 500 it always was.
    const bug = new TypeError('boom');
    const strapi = fakeStrapi({ human: true });
    const validator = COLLECTED_STEPS.find(
      (candidate) => candidate.name === 'validateChangedFields',
    )!;
    const spy = vi
      .spyOn(validator, 'run')
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

describe('runWriteValidation — translation writes use narrow source-parity exceptions', () => {
  // The Arabic copy of an entry that already passed every rule. Read against
  // the English stored row, its denser text fails the 160-char minimum and
  // its not-yet-translated relations read as "orphaned" — the two rejections
  // that dead-lettered the UAE backfill. Group A still runs on it.
  const translated = {
    name: 'أمازون',
    shortDescription: '  متجر إلكتروني رائد  ',
    logo: { documentId: 'logo-1' },
    logoAlt: 'شعار أمازون',
    seo: { metaTitle: 'كوبونات أمازون', metaDescription: 'وفّر باستخدام الأكواد.' },
  };

  // The writer always targets a content locale: documents().update({ locale }).
  const arabicWrite = (data: any) => ({
    ...write('api::store.store', data, 'update'),
    params: { data, locale: 'ar' },
  });

  const englishSource = {
    ...translated,
    name: 'Amazon',
    slug: 'amazon',
    shortDescription: 'x'.repeat(200),
    logoAlt: 'Amazon logo',
    seo: { metaTitle: 'Amazon coupons', metaDescription: 'Save with verified codes.' },
  };

  const asTranslation = (data: any, targetRowExisted = false) =>
    runWithTranslationWriteContext(
      {
        sourceEntry: englishSource,
        targetLocale: 'ar',
        plan: { data, skippedRelations: [] },
        targetRowExisted,
        operation: 'upsert',
      },
      () => runWriteValidation(fakeStrapi({ human: false }), arabicWrite(data)),
    );

  it('allows the locale-specific short description rule while validators still run', async () => {
    const payload = arabicWrite({ ...translated });
    await expect(
      runWithTranslationWriteContext(
        {
          sourceEntry: englishSource,
          targetLocale: 'ar',
          plan: { data: payload.params.data, skippedRelations: [] },
          targetRowExisted: false,
          operation: 'upsert',
        },
        () => runWriteValidation(fakeStrapi({ human: false }), payload),
      ),
    ).resolves.toBeNull();
    // Mutators still normalise the payload the write will persist.
    expect(payload.params.data.shortDescription).toBe('متجر إلكتروني رائد');
  });

  it('rejects a target-only defect even under the translation flag', async () => {
    const error = await caught(() =>
      asTranslation({ ...translated, logoAlt: '' }),
    );
    expect(error.details?.errors?.map((e) => e.path.join('.'))).toContain('logoAlt');
  });

  it('validates shared source values without adding them to the locale plan', async () => {
    const localizedPlan = { ...translated };
    const invalidSource = {
      ...englishSource,
      slug: 'Bad_Slug',
    };
    const error = await caught(() =>
      runWithTranslationWriteContext(
        {
          sourceEntry: invalidSource,
          targetLocale: 'ar',
          plan: { data: localizedPlan, skippedRelations: [] },
          targetRowExisted: false,
          operation: 'upsert',
        },
        () =>
          runWriteValidation(
            fakeStrapi({ human: false }),
            arabicWrite(localizedPlan),
          ),
      ),
    );

    // Arabic does not own the route slug, but schema/SEO rules still inspect
    // the effective source+plan record. The provider-facing plan remains
    // locale-only throughout.
    expect(error.details?.errors?.length).toBeGreaterThan(0);
    expect(localizedPlan).not.toHaveProperty('slug');
  });

  it('lets a first locale version keep its own English row out of uniqueness checks', async () => {
    // A job's slug is shared across locales. Its first Arabic write validates
    // as a create (no target row yet) but with the shared documentId, so the
    // English row it finds is the same document — not a collision.
    // The only job with this slug is the document being translated.
    const findFirst = vi.fn(async ({ filters }: any) =>
      filters?.documentId?.$ne === 'job-1'
        ? null
        : { documentId: 'job-1', slug: 'senior-editor', title: 'Senior editor' },
    );
    const strapi = fakeStrapi({ human: false }) as any;
    strapi.documents = () => ({
      findOne: async () => null,
      findFirst,
      findMany: async () => [],
      count: async () => 0,
    });
    const plan = { title: 'محرر أول', category: 'التحرير' };
    const source = { ...plan, documentId: 'job-1', title: 'Senior editor', slug: 'senior-editor', category: 'Editorial' };
    await expect(
      runWithTranslationWriteContext(
        {
          sourceEntry: source,
          targetLocale: 'ar',
          plan: { data: plan, skippedRelations: [] },
          targetRowExisted: false,
          operation: 'upsert',
        },
        () =>
          runWriteValidation(strapi, {
            uid: 'api::job.job',
            action: 'update',
            params: { data: plan, locale: 'ar', documentId: 'job-1' },
          }),
      ),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ documentId: { $ne: 'job-1' } }),
      }),
    );
  });

  it('does not judge the source offer lifecycle on a translation write', async () => {
    // Every lifecycle field is non-localized and copied from English; an
    // already-expired offer is a stored state, not a target defect.
    const lifecycle = COLLECTED_STEPS.find((s) => s.name === 'validateOfferLifecycle')!;
    const base = {
      strapi: {
        ...(fakeStrapi({ human: false }) as any),
        contentType: () => ({ attributes: {} }),
      },
      uid: 'api::coupon.coupon',
      action: 'create',
      data: { title: 'عرض منتهي', expiresAt: '2020-01-01T00:00:00.000Z' },
      documentId: 'coupon-1',
      strict: true,
      locale: 'ar',
    } as any;
    await expect(lifecycle.run({ ...base, translation: null })).rejects.toThrow(
      /Expires at must be in the future/u,
    );
    // The step short-circuits synchronously: no validator call at all.
    expect(
      lifecycle.run({
        ...base,
        translation: {
          sourceEntry: { expiresAt: '2020-01-01T00:00:00.000Z' },
          targetLocale: 'ar',
          plan: { data: base.data, skippedRelations: [] },
          targetRowExisted: false,
          operation: 'upsert',
        },
      }),
    ).toBeUndefined();
  });

  it('rejects the same short description outside the flag', async () => {
    const error = await caught(() =>
      runWriteValidation(fakeStrapi({ human: false }), arabicWrite({ ...translated })),
    );
    const paths = error.details?.errors?.map((e) => e.path.join('.'));
    expect(paths).toContain('shortDescription');
  });
});
