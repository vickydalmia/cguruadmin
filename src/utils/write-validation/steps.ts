import type { Core } from '@strapi/strapi';

import {
  normaliseAffiliateOfferFields,
  validateAffiliateBrandFlip,
  validateAffiliateOfferForWrite,
} from '../affiliate-offer-consistency';
import { isAffiliateOfferUid } from '../../constants/affiliate-offer';
import { validateChangedFields } from '../changed-field-validation';
import { validateCheckoutMerchantForWrite } from '../checkout-merchant-validation';
import { isCheckoutMerchantOfferUid } from '../../constants/checkout-merchant';
import {
  isOfferStoreUid,
  validateContentManagerOfferStore,
} from '../content-manager-offer-store-validation';
import {
  isCouponUid,
  normaliseCouponTypeFields,
  validateCouponTypeFields,
} from '../coupon-type-consistency';
import { ensureTransparentDealImageForWrite } from '../deal-image-write-validation';
import { validateDealOfTheDaySectionLimits } from '../deal-of-the-day-validation';
import { validateEntityFieldsForWrite } from '../entity-field-validation';
import {
  isFestiveOfferUid,
  normaliseFestiveOfferFields,
} from '../festive-offer-consistency';
import { validateEntityDealPageSeo } from '../entity-deal-page-seo-validation';
import {
  isEntityTopPickUid,
  validateEntityTopPickCoupons,
} from '../entity-top-pick-validation';
import {
  isEntityOrderedCouponUid,
  validateEntityOrderedCoupons,
} from '../entity-ordered-coupon-validation';
import { validateHomepageImages } from '../homepage-image-validation';
import { normaliseHomepageHeroOfferFields } from '../homepage-hero-offer';
import { validateHomepageHeroOffers } from '../homepage-hero-offer-validation';
import { validateHomepagePopularStores } from '../homepage-popular-stores-validation';
import { validateHomepagePopularSearches } from '../homepage-popular-searches-validation';
import { validateIndependenceDaySale } from '../independence-day-sale-validation';
import { validateIdentity } from '../identity-validation';
import { validateJobSlug } from '../job-slug-validation';
import { MENU_UID, validateMenuCategorySections } from '../menu-category-validation';
import { validateMenuNotification } from '../menu-notification-validation';
import { validateOfferFieldsForWrite } from '../offer-field-validation';
import {
  isOfferLifecycleUid,
  validateOfferLifecycle,
} from '../offer-lifecycle-validation';
import { validateRedirect } from '../redirect-validation';
import { warnUndersizedSeoOgImage } from '../seo-og-image-validation';
import { sanitizeRichtextData } from '../sanitize-richtext';
import { normaliseTextFields, validateTextFieldsForWrite } from '../text-field-validation';
import { SITE_CONFIGURATION_UID } from '../../api/site-configuration/services/country-registry';
import { validateSiteConfigurationForWrite } from '../../api/site-configuration/services/site-configuration';
import {
  isEntityTemplateUid,
  validateUniqueEntityPageTemplate,
} from '../entity-page-template-validation';

import { DOTD_UID } from '../../constants/deal-of-the-day-sections';
import { HOMEPAGE_UID } from '../../constants/homepage-sections';
import { INDEPENDENCE_DAY_SALE_UID } from '../../constants/independence-day-sale-sections';

/**
 * The write-validation pipeline, as data.
 *
 * This is the same list of calls the document-write middleware
 * (src/register/document-write-middleware.ts) used to inline, in the same order, with the same guards — lifted out so the
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
  /**
   * `context.params.locale` — set on writes that target a non-default content
   * locale (a manual Arabic edit, the translation writer). Validators that
   * read the STORED row to resolve a partial payload must read the row of the
   * locale being written, or they would judge an `ar` save against the `en`
   * document. Undefined means the default locale.
   */
  locale?: string;
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
  {
    // Same trap as normaliseCouponTypeFields, one content type over: the
    // festive title/description are `conditions.visible` fields, so turning
    // the toggle off OMITS them from the payload and leaves the stored values
    // live. Clear them explicitly. Runs AFTER sanitizeRichtextData on purpose
    // — sanitizing a value that is about to become null is wasted work, but
    // the reverse order would sanitize nothing and leave the cleared field
    // untouched only by luck; keeping it last in the group makes the "clears
    // what earlier steps normalised" direction explicit.
    name: 'normaliseFestiveOfferFields',
    applies: isFestiveOfferUid,
    run: ({ data }) => normaliseFestiveOfferFields(data),
  },
  {
    // Inverse direction of the festive pair: `logoStore`/`checkoutMerchant`
    // are visible-when-OFF, so turning the affiliate toggle ON hides them,
    // OMITS them from the payload, and would leave the stored values live.
    // Clear them explicitly. No-ops when the toggle is absent, so partial
    // writes (cron, imports) never wipe a Logo Store as a side effect.
    name: 'normaliseAffiliateOfferFields',
    applies: isAffiliateOfferUid,
    run: ({ data }) => normaliseAffiliateOfferFields(data),
  },
  {
    // Hero Offer relation fields are conditional. Switching the discriminator
    // hides and omits the previous relation, so clear it before validation.
    name: 'normaliseHomepageHeroOfferFields',
    applies: (uid) => uid === HOMEPAGE_UID,
    run: ({ data }) => normaliseHomepageHeroOfferFields(data),
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
    name: 'validateSiteConfigurationForWrite',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === SITE_CONFIGURATION_UID,
    run: ({ strapi, data, documentId }) =>
      validateSiteConfigurationForWrite(strapi, data, documentId),
  },
  {
    name: 'validateCouponTypeFields',
    applies: isCouponUid,
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateCouponTypeFields(strapi, uid as any, action, data, documentId, strict),
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
    // SOFT check (never throws): an ogImage below 1200×630 logs a warning but
    // the save goes through — the catalogue is migrated from WordPress with
    // arbitrary image sizes and must stay editable.
    name: 'warnUndersizedSeoOgImage',
    run: ({ strapi, uid, action, data }) =>
      warnUndersizedSeoOgImage(strapi, uid, action, data),
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
    name: 'validateHomepageHeroOffers',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === HOMEPAGE_UID,
    run: ({ strapi, data, locale }) =>
      validateHomepageHeroOffers(strapi, data, locale),
  },
  {
    name: 'validateHomepagePopularStores',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === HOMEPAGE_UID,
    run: ({ strapi, data, documentId }) =>
      validateHomepagePopularStores(strapi, data, documentId),
  },
  {
    name: 'validateHomepagePopularSearches',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === HOMEPAGE_UID,
    run: ({ strapi, data, documentId }) =>
      validateHomepagePopularSearches(strapi, data, documentId),
  },
  {
    name: 'validateMenuCategorySections',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === MENU_UID,
    run: ({ strapi, data, documentId }) =>
      validateMenuCategorySections(strapi, data, documentId),
  },
  {
    name: 'validateMenuNotification',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === MENU_UID,
    run: ({ strapi, data, documentId }) =>
      validateMenuNotification(strapi, data, documentId),
  },
  {
    name: 'validateDealOfTheDaySectionLimits',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === DOTD_UID,
    run: ({ strapi, data, locale }) =>
      validateDealOfTheDaySectionLimits(strapi, data, locale),
  },
  {
    name: 'validateIndependenceDaySale',
    actions: CREATE_UPDATE,
    applies: (uid) => uid === INDEPENDENCE_DAY_SALE_UID,
    run: ({ strapi, data, locale }) =>
      validateIndependenceDaySale(strapi, data, locale),
  },
  {
    name: 'validateContentManagerOfferStore',
    applies: isOfferStoreUid,
    run: ({ strapi, uid, action, data, documentId }) =>
      isOfferStoreUid(uid)
        ? validateContentManagerOfferStore(
            strapi,
            uid,
            action,
            data,
            documentId,
          )
        : undefined,
  },
  {
    // Affiliate-brand offers: toggle ON means zero Stores, only affiliate
    // Brands, and no payload-explicit logoStore/checkoutMerchant. CM-gated
    // inside, same as the one-Store rule above.
    name: 'validateAffiliateOfferForWrite',
    applies: isAffiliateOfferUid,
    run: ({ strapi, uid, action, data, documentId }) =>
      isAffiliateOfferUid(uid)
        ? validateAffiliateOfferForWrite(strapi, uid, action, data, documentId)
        : undefined,
  },
  {
    // The other half of the affiliate invariant: a Brand cannot drop its
    // "Affiliate Store" flag while affiliate offers still reference it.
    name: 'validateAffiliateBrandFlip',
    applies: (uid) => uid === 'api::brand.brand',
    run: ({ strapi, uid, action, data, documentId }) =>
      validateAffiliateBrandFlip(strapi, uid, action, data, documentId),
  },
  {
    // checkoutMerchant is a custom STRING field, not a relation, so nothing at
    // the database level stops a write from referencing a Store or Brand that
    // does not exist. This is that check.
    name: 'validateCheckoutMerchantForWrite',
    applies: isCheckoutMerchantOfferUid,
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateCheckoutMerchantForWrite(
        strapi,
        uid,
        action,
        data,
        documentId,
        strict,
      ),
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
    run: ({ strapi, uid, action, data, documentId, strict, locale }) =>
      validateOfferFieldsForWrite(
        strapi,
        uid,
        action,
        data,
        documentId,
        strict,
        locale,
      ),
  },
  {
    // Taxonomy cross-field checks: rating range, FAQ-enabled-but-empty,
    // brand required SEO.
    name: 'validateEntityFieldsForWrite',
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateEntityFieldsForWrite(strapi, uid, action, data, documentId, strict),
  },
  {
    // Hidden today, but still writable by the dedicated Super Admin API,
    // imports, and future admin settings UI.
    name: 'validateEntityDealPageSeo',
    run: ({ uid, data }) => validateEntityDealPageSeo(uid, data),
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
 * Slug, template-owner and redirect invariants are validated with plain reads and committed by
 * an INDEPENDENT write, so two concurrent saves can both pass on the same
 * snapshot and both commit. The middleware serializes them under one advisory
 * lock per domain (see write-serialization.ts).
 *
 * They are a separate group precisely so that lock is never taken for a save
 * group B has already condemned. Within the group they are still collected
 * together, so a redirect with a bad `from` AND a bad `to` reports both.
 *
 * All of them run for EVERY uid — each one no-ops internally on a type it
 * does not own. That is deliberately unchanged from the original middleware.
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
    // Singleton campaign templates can have exactly one entity owner. This
    // read-then-write check shares the entity identity lock so concurrent
    // creates/updates/clones cannot both claim the same template.
    name: 'validateUniqueEntityPageTemplate',
    applies: isEntityTemplateUid,
    run: ({ strapi, uid, action, data, documentId }) =>
      validateUniqueEntityPageTemplate(strapi, data, documentId, action, uid),
  },
  {
    // Redirects are evaluated by the storefront middleware on EVERY request,
    // before routing, with no code review between the editor and production.
    name: 'validateRedirect',
    run: ({ strapi, uid, action, data, documentId, strict }) =>
      validateRedirect(strapi, uid, action, data, documentId, strict),
  },
  {
    // Job slugs are plain strings with no uid/DB uniqueness; /careers/<slug>/
    // and the application submit endpoint both take the first matching row.
    name: 'validateJobSlug',
    run: ({ strapi, uid, action, data, documentId }) =>
      validateJobSlug(strapi, uid, action, data, documentId),
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
