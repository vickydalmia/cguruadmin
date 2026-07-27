import type { Core } from '@strapi/strapi';

import { validateChangedFields } from '../changed-field-validation';
import {
  isCouponUid,
  normaliseCouponTypeFields,
  validateCouponTypeFields,
} from '../coupon-type-consistency';
import { ensureTransparentDealImageForWrite } from '../deal-image-upload';
import { validateDealOfTheDaySectionLimits } from '../deal-of-the-day-validation';
import { validateEntityFieldsForWrite } from '../entity-field-validation';
import {
  isEntityTopPickUid,
  validateEntityTopPickCoupons,
} from '../entity-top-pick-validation';
import {
  isEntityOrderedCouponUid,
  validateEntityOrderedCoupons,
} from '../entity-ordered-coupon-validation';
import { validateHomepageImages } from '../homepage-image-validation';
import { validateHomepagePopularSearches } from '../homepage-popular-searches-validation';
import { validateIdentity } from '../identity-validation';
import { validateOfferFieldsForWrite } from '../offer-field-validation';
import {
  isOfferLifecycleUid,
  validateOfferLifecycle,
} from '../offer-lifecycle-validation';
import { validateRedirect } from '../redirect-validation';
import { sanitizeRichtextData } from '../sanitize-richtext';
import { normaliseTextFields, validateTextFieldsForWrite } from '../text-field-validation';

import { DOTD_UID } from '../../constants/deal-of-the-day-sections';
import { HOMEPAGE_UID } from '../../constants/homepage-sections';

/**
 * The write-validation pipeline, as data.
 *
 * This is the same list of calls the document middleware in src/index.ts used
 * to inline, in the same order, with the same guards — lifted out so the
 * middleware can decide HOW to run them (fail fast, or collect everything and
 * report once) without that decision being tangled up in a 200-line if/await
 * chain.
 */

export type StepContext = {
  strapi: Core.Strapi;
  uid: string;
  action: string;
  /** `context.params.data` — mutated in place by the MUTATOR_STEPS. */
  data: any;
  documentId?: string;
  /**
   * "Clean as you touch": true for a human admin save, false for the status
   * cron. Threaded through to the validators that accept it; each one owns its
   * own grandfathering, this pipeline never second-guesses them.
   */
  strict: boolean;
};

export type ValidationStep = {
  /** Stable id. Asserted by run.test.ts so the order below cannot drift. */
  name: string;
  /** Document actions this step runs for. Defaults to the write triple. */
  actions?: readonly string[];
  /** Content types this step runs for. Defaults to every uid. */
  applies?: (uid: string) => boolean;
  run: (ctx: StepContext) => unknown | Promise<unknown>;
};

/** The three actions that carry an editable payload. */
export const WRITE_ACTIONS = ['create', 'update', 'clone'] as const;

/**
 * A few steps predate clone support and have always been create/update only.
 * Kept verbatim — widening them here would be a silent behaviour change.
 */
const CREATE_UPDATE = ['create', 'update'] as const;

export function stepApplies(step: ValidationStep, uid: string, action: string): boolean {
  const actions = step.actions ?? WRITE_ACTIONS;
  if (!actions.includes(action)) return false;
  return step.applies ? step.applies(uid) : true;
}

// ---------------------------------------------------------------------------
// Group A — mutators
// ---------------------------------------------------------------------------

/**
 * Run first, never throw. These rewrite `data` in place so that every validator
 * downstream checks byte-exactly what will be stored.
 *
 * ORDER IS LOAD-BEARING, here and in every array below. `normaliseTextFields`
 * must trim before the required-field check sees "   ", and
 * `normaliseCouponTypeFields` must clear `code` before `validateChangedFields`
 * length-checks it. Do not sort, group or "tidy" these lists.
 */
export const MUTATOR_STEPS: readonly ValidationStep[] = [
  {
    // Richtext holds HTML rendered raw on the public site — enforce the
    // migration-era allowlist on every write, whatever the editor.
    name: 'sanitizeRichtextData',
    run: ({ uid, data }) => sanitizeRichtextData(uid, data),
  },
  {
    // Trim/collapse before ANY validator reads a value. Collapse is
    // string-only; collapsing a text/richtext field would destroy paragraphs.
    name: 'normaliseTextFields',
    run: ({ uid, action, data }) => normaliseTextFields(uid, action, data),
  },
  {
    // A coupon owns exactly one of `code` / `uniqueCouponPool`. The admin hides
    // the irrelevant one, so it is OMITTED from the payload and the stored
    // value stays attached — clear it explicitly. No-ops when couponType is
    // absent, so the cron's partial updates never detach a scheduled pool.
    name: 'normaliseCouponTypeFields',
    applies: isCouponUid,
    run: ({ data }) => normaliseCouponTypeFields(data),
  },
];

// ---------------------------------------------------------------------------
// Group B — pure validators, collected into one error
// ---------------------------------------------------------------------------

/**
 * Every editor-facing rule that is a pure read-and-check. These all run on a
 * failing save and their problems are merged, so one Save reports everything.
 *
 * Safe to run past a failure because each is defensive about its own inputs and
 * none depends on an earlier one having *passed* — only on the mutators above
 * having run, which they always do.
 */
export const COLLECTED_STEPS: readonly ValidationStep[] = [
  {
    name: 'validateCouponTypeFields',
    applies: isCouponUid,
    run: ({ strapi, action, data, documentId, strict }) =>
      validateCouponTypeFields(strapi, action, data, documentId, strict),
  },
  {
    // Constraints introduced on populated fields cannot live in the Strapi
    // schema: the admin sends a full form on update and schema validation
    // cannot grandfather an unchanged legacy value.
    name: 'validateChangedFields',
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateChangedFields(strapi, uid, action, data, documentId, strict),
  },
  {
    // Homepage section images must match their Figma sizes exactly — reject
    // before any side effect (ISR enqueue, cache purge, override fill).
    name: 'validateHomepageImages',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === HOMEPAGE_UID,
    run: ({ strapi, data }) => validateHomepageImages(strapi, data),
  },
  {
    name: 'validateHomepagePopularSearches',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === HOMEPAGE_UID,
    run: ({ strapi, data, documentId }) =>
      validateHomepagePopularSearches(strapi, data, documentId),
  },
  {
    name: 'validateDealOfTheDaySectionLimits',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === DOTD_UID,
    run: ({ strapi, data }) => validateDealOfTheDaySectionLimits(strapi, data),
  },
  {
    name: 'validateEntityTopPickCoupons',
    actions: CREATE_UPDATE,
    applies: isEntityTopPickUid,
    // `applies` has already narrowed this; re-running the guard keeps the
    // narrowed uid type without a cast.
    run: ({ strapi, uid, data, documentId }) =>
      isEntityTopPickUid(uid)
        ? validateEntityTopPickCoupons(strapi, uid, data, documentId)
        : undefined,
  },
  {
    name: 'validateEntityOrderedCoupons',
    actions: CREATE_UPDATE,
    applies: isEntityOrderedCouponUid,
    run: ({ strapi, uid, data, documentId }) =>
      isEntityOrderedCouponUid(uid)
        ? validateEntityOrderedCoupons(strapi, uid, data, documentId)
        : undefined,
  },
  {
    // Offer badge / cashback / bank texts are word-capped so they fit the fixed
    // card slots.
    name: 'validateOfferFieldsForWrite',
    applies: (uid) => uid === 'api::coupon.coupon' || uid === 'api::deal.deal',
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateOfferFieldsForWrite(strapi, uid, action, data, documentId, strict),
  },
  {
    // Taxonomy cross-field checks: rating range, FAQ-enabled-but-empty,
    // brand required SEO.
    name: 'validateEntityFieldsForWrite',
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateEntityFieldsForWrite(strapi, uid, action, data, documentId, strict),
  },
  {
    // contentStatus is DERIVED from scheduledAt/expiresAt, never editor-set.
    // Also mutates `data` — deriving from the payload alone would read the
    // cron's partial {contentStatus} update as "no dates".
    name: 'validateOfferLifecycle',
    applies: isOfferLifecycleUid,
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateOfferLifecycle(strapi, uid, action, data, documentId, strict),
  },
  {
    // Blank-after-trim rejection and required-field enforcement.
    name: 'validateTextFieldsForWrite',
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateTextFieldsForWrite(strapi, uid, action, data, documentId, strict),
  },
];

// ---------------------------------------------------------------------------
// Group C — invariants that need the write-serialization lock
// ---------------------------------------------------------------------------

/**
 * Slug and redirect invariants are validated with plain reads and committed by
 * an INDEPENDENT write, so two concurrent saves can both pass on the same
 * snapshot and both commit. The middleware serializes them under one advisory
 * lock per domain (see write-serialization.ts).
 *
 * They are a separate group precisely so that lock is never taken for a save
 * group B has already condemned. Within the group they are still collected
 * together, so a redirect with a bad `from` AND a bad `to` reports both.
 *
 * Both run for EVERY uid — each one no-ops internally on a type it does not
 * own. That is deliberately unchanged from the original middleware.
 */
export const LOCKED_STEPS: readonly ValidationStep[] = [
  {
    // Name unique per type, slug unique across all four taxonomies (the public
    // URL space is flat), and no collision with a reserved Astro route.
    name: 'validateIdentity',
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateIdentity(strapi, uid, action, data, documentId, strict),
  },
  {
    // Redirects are evaluated by the storefront middleware on EVERY request,
    // before routing, with no code review between the editor and production.
    name: 'validateRedirect',
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateRedirect(strapi, uid, action, data, documentId, strict),
  },
];

// ---------------------------------------------------------------------------
// Group D — side effects
// ---------------------------------------------------------------------------

/**
 * Runs LAST, and fails fast.
 *
 * Product Deal media is a transparent-only contract, and honouring it means
 * calling a paid background-removal provider. It used to run third, which
 * meant a deal saved with an opaque image and a blank Offer text burned a
 * credit before the save was rejected anyway. Nothing in groups A–C reads the
 * `dealImage` value this step writes, so deferring it is free.
 */
export const SIDE_EFFECT_STEPS: readonly ValidationStep[] = [
  {
    name: 'ensureTransparentDealImageForWrite',
    applies: (uid) => uid === 'api::deal.deal',
    run: ({ strapi, data }) => ensureTransparentDealImageForWrite(strapi, data),
  },
];
