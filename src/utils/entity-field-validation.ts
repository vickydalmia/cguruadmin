import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

import {
  FESTIVE_OFFER_FIELDS,
  isFestiveOfferUid,
} from './festive-offer-consistency';

/**
 * Cross-field validation for the taxonomy content types (store / brand /
 * category / bank), run from the documents middleware on create+update. Throws
 * the same ValidationError shape as offer-field-validation / homepage-image
 * validation so the admin highlights the offending field inline
 * (details.errors[].path → inline error) instead of surfacing a raw 500.
 *
 * Rules:
 *  - ratingCount / ratingAverage range — a manual ratingCount above the
 *    Postgres integer limit used to blow up with an unlabelled 500; cap it (and
 *    re-assert ratingAverage 0–5) with a friendly field error instead.
 *  - FAQ enabled but empty — `faqEnabled` on with no `faqs` rows is almost
 *    always a mistake; require at least one item.
 *  - Festive offer enabled but empty — same shape one field over. Store and
 *    Brand carry `isFestiveOffer` plus a title and a rich-text description
 *    that the schema only makes VISIBLE when the toggle is on. Visibility is
 *    not requiredness: Strapi skips validation entirely for a hidden field, so
 *    "on with nothing filled in" has to be caught here.
 *  - Brand required fields — SEO title/description are mandatory on brand. (The
 *    scalar/media required fields — shortDescription, logo, slug — are enforced
 *    natively via `required: true` in the brand schema; SEO lives in the SHARED
 *    `shared.seo` component, so it can only be required brand-side here.)
 */

const ENTITY_UIDS = [
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
] as const;

// Below the Postgres `integer` ceiling (2,147,483,647) with headroom, so a
// large-but-sane count still saves while a fat-fingered value is rejected
// before it reaches the DB driver.
const RATING_COUNT_MAX = 2_000_000_000;

type Problem = { path: (string | number)[]; message: string };

const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '');

function sameNumber(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || left === '') {
    return right === null || right === undefined || right === '';
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber) &&
    leftNumber === rightNumber;
}

function checkRatingRange(
  data: any,
  action: string,
  stored: any,
  problems: Problem[],
  strict: boolean,
): void {
  const rc = data.ratingCount;
  if (rc !== undefined && rc !== null && rc !== '') {
    const n = typeof rc === 'string' ? Number(rc) : rc;
    if (!Number.isInteger(n) || n < 0 || n > RATING_COUNT_MAX) {
      // strict re-arms the check on the whole effective record, so a dirty
      // untouched (== stored) value is no longer grandfathered.
      if (strict || !(action === 'update' && stored && sameNumber(rc, stored.ratingCount))) {
        problems.push({
          path: ['ratingCount'],
          message: `Rating count must be a whole number between 0 and ${RATING_COUNT_MAX.toLocaleString(
            'en-US'
          )} — got "${rc}".`,
        });
      }
    }
  }

  const ra = data.ratingAverage;
  if (ra !== undefined && ra !== null && ra !== '') {
    const n = typeof ra === 'string' ? Number(ra) : ra;
    if (!Number.isFinite(n) || n < 0 || n > 5) {
      if (strict || !(action === 'update' && stored && sameNumber(ra, stored.ratingAverage))) {
        problems.push({
          path: ['ratingAverage'],
          message: `Rating average must be a number between 0 and 5 — got "${ra}".`,
        });
      }
    }
  }
}

function checkFaqEnabled(
  data: any,
  action: string,
  stored: any,
  problems: Problem[],
  strict: boolean,
): void {
  const hasEnabled = Object.prototype.hasOwnProperty.call(data, 'faqEnabled');
  const hasFaqs = Object.prototype.hasOwnProperty.call(data, 'faqs');
  const enabled = hasEnabled ? data.faqEnabled : stored?.faqEnabled;
  const faqs = hasFaqs ? data.faqs : stored?.faqs;
  if (enabled !== true) return;
  if (!Array.isArray(faqs) || faqs.length === 0) {
    // strict enforces the FAQ rule on the effective record even when the
    // legacy enabled-but-empty state was never touched by this write.
    if (
      !strict &&
      action === 'update' &&
      stored?.faqEnabled === true &&
      (!Array.isArray(stored.faqs) || stored.faqs.length === 0)
    ) {
      return;
    }
    problems.push({
      path: ['faqs'],
      message: 'Add at least one FAQ, or turn "FAQ enabled" off.',
    });
  }
}

/**
 * `isFestiveOffer` on requires BOTH conditional fields to be filled in. Only
 * Store and Brand carry the trio — category and bank fall straight through.
 *
 * Grandfathering mirrors checkFaqEnabled exactly: an update that leaves an
 * already-broken legacy row exactly as broken as it found it is allowed
 * through, so an editor fixing an unrelated typo is not held hostage by a
 * festive offer somebody half-configured months ago. `strict` re-arms it.
 *
 * The 60-character cap on the title is NOT checked here — it lives in
 * changed-field-validation.ts with the other length rules, which derives the
 * editor-facing hint from the same number it enforces.
 */
function checkFestiveOffer(
  data: any,
  action: string,
  stored: any,
  problems: Problem[],
  strict: boolean,
): void {
  const has = (field: string) =>
    Object.prototype.hasOwnProperty.call(data, field);

  const enabled = has('isFestiveOffer')
    ? data.isFestiveOffer
    : stored?.isFestiveOffer;
  if (enabled !== true) return;

  const fields = [
    { name: 'festiveOfferTitle', label: 'Add the festive offer title' },
    {
      name: 'festiveOfferDescription',
      label: 'Add the festive offer description',
    },
  ] as const;

  for (const { name, label } of fields) {
    const value = has(name) ? data[name] : stored?.[name];
    if (!isBlank(value)) continue;

    // Already broken before this write, and this write is not about it:
    // leave it alone unless strict says judge the whole record.
    //
    // "Not about it" has to mean the payload carries NEITHER the toggle nor
    // this field. Testing the stored state alone would grandfather an editor
    // who just blanked the title by hand — they touched it, so it is this
    // save's problem, not the legacy row's.
    if (
      !strict &&
      action === 'update' &&
      !has('isFestiveOffer') &&
      !has(name) &&
      stored?.isFestiveOffer === true &&
      isBlank(stored?.[name])
    ) {
      continue;
    }

    problems.push({
      path: [name],
      message: `${label}, or turn "Is festive offer" off.`,
    });
  }
}

function checkBrandRequired(
  data: any,
  action: string,
  stored: any,
  problems: Problem[],
  strict: boolean,
): void {
  // Enforce SEO on create always; on update only when the seo component is part
  // of the payload (a partial API update that omits it can't be judged here —
  // the admin edit form always sends the whole document). Under strict the
  // whole effective record is judged, so required SEO is enforced even when the
  // seo component is absent from this write.
  if (!strict && !['create', 'clone'].includes(action) && !('seo' in data)) return;
  const seo = data.seo ?? {};
  if (isBlank(seo.metaTitle)) {
    if (strict || !(action === 'update' && stored && isBlank(stored.seo?.metaTitle))) {
      problems.push({ path: ['seo', 'metaTitle'], message: 'SEO title is required.' });
    }
  }
  if (isBlank(seo.metaDescription)) {
    if (strict || !(action === 'update' && stored && isBlank(stored.seo?.metaDescription))) {
      problems.push({
        path: ['seo', 'metaDescription'],
        message: 'SEO description is required.',
      });
    }
  }
}

function cloneEffectiveData(data: any, stored: any): any {
  if (!stored || typeof stored !== 'object') return data;
  const effective = { ...stored, ...data };
  if (Object.prototype.hasOwnProperty.call(data, 'seo')) {
    effective.seo =
      data.seo && typeof data.seo === 'object'
        ? { ...(stored.seo ?? {}), ...data.seo }
        : data.seo;
  }
  return effective;
}

/**
 * Validate a taxonomy payload. No-op for any other content type. Throws
 * errors.ValidationError listing every problem (fields highlighted inline).
 */
export function validateEntityFields(
  uid: string,
  action: string,
  data: any,
  stored: any = null,
  strict: boolean = false,
): void {
  if (!ENTITY_UIDS.includes(uid as (typeof ENTITY_UIDS)[number])) return;
  if (!data || typeof data !== 'object') return;

  // strict validates the full effective record, which is exactly the
  // payload-over-stored merge the clone path already builds — reuse it (the
  // single cloneEffectiveData merge, not a second layer).
  const effective =
    action === 'clone' || strict ? cloneEffectiveData(data, stored) : data;
  const problems: Problem[] = [];
  checkRatingRange(effective, action, stored, problems, strict);
  checkFaqEnabled(effective, action, stored, problems, strict);
  if (isFestiveOfferUid(uid)) {
    checkFestiveOffer(effective, action, stored, problems, strict);
  }
  if (uid === 'api::brand.brand') {
    checkBrandRequired(effective, action, stored, problems, strict);
  }

  if (problems.length) {
    const noun = problems.length === 1 ? 'problem' : 'problems';
    throw new errors.ValidationError(
      `This entry has ${problems.length} ${noun} (the fields are highlighted ` +
        `in the form):\n• ${problems
          .map((p) => `${p.path.join('.')}: ${p.message}`)
          .join('\n• ')}`,
      {
        // The admin edit view maps details.errors[].path to an inline error on
        // that exact field (same mechanism as the offer/homepage validators).
        errors: problems.map((p) => ({
          path: p.path,
          message: p.message,
          name: 'ValidationError',
        })),
        // Flat shape kept for non-admin API consumers.
        problems: problems.map((p) => `${p.path.join('.')}: ${p.message}`),
      }
    );
  }
}

export async function validateEntityFieldsForWrite(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: any,
  documentId?: string,
  strict: boolean = false,
  locale?: string,
): Promise<void> {
  if (!ENTITY_UIDS.includes(uid as (typeof ENTITY_UIDS)[number])) return;
  if (!data || typeof data !== 'object') return;

  const has = (field: string) =>
    Object.prototype.hasOwnProperty.call(data, field);
  const ratingFields = ['ratingCount', 'ratingAverage'].filter(has);
  const faqTouched = has('faqEnabled') || has('faqs');
  const seoTouched = uid === 'api::brand.brand' && has('seo');
  const festiveTouched =
    isFestiveOfferUid(uid) &&
    (has('isFestiveOffer') || FESTIVE_OFFER_FIELDS.some(has));
  const isClone = action === 'clone';
  // strict needs the WHOLE stored record to build the effective merge — the
  // same complete cross-field read the clone path already performs.
  const wantsFullRecord = isClone || strict;

  let stored: unknown = null;
  if (
    (action === 'update' || isClone) &&
    documentId &&
    (wantsFullRecord ||
      ratingFields.length > 0 ||
      faqTouched ||
      seoTouched ||
      festiveTouched)
  ) {
    const fields = [
      'documentId',
      ...(wantsFullRecord ? ['ratingCount', 'ratingAverage'] : ratingFields),
      ...(wantsFullRecord || faqTouched ? ['faqEnabled'] : []),
      // The toggle AND both conditional fields: checkFestiveOffer needs the
      // stored value of whichever one this payload leaves out, and its
      // grandfathering clause needs to know whether the stored row was
      // already enabled-but-empty.
      ...(isFestiveOfferUid(uid) && (wantsFullRecord || festiveTouched)
        ? ['isFestiveOffer', ...FESTIVE_OFFER_FIELDS]
        : []),
    ];
    const populate: Record<string, unknown> = {};
    if (wantsFullRecord || faqTouched) populate.faqs = true;
    if (uid === 'api::brand.brand' && (wantsFullRecord || seoTouched)) {
      populate.seo = {
        fields: ['metaTitle', 'metaDescription'],
      };
    }

    stored = await strapi.documents(uid as any).findOne({
      documentId,
      ...(locale ? { locale } : {}),
      fields: [...new Set(fields)] as any,
      ...(Object.keys(populate).length > 0 ? { populate: populate as any } : {}),
    });
  }
  if (isClone && documentId && !stored) return;

  validateEntityFields(uid, action, data, stored, strict);
}
