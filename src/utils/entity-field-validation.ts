import { errors } from '@strapi/utils';

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

function checkRatingRange(data: any, problems: Problem[]): void {
  const rc = data.ratingCount;
  if (rc !== undefined && rc !== null && rc !== '') {
    const n = typeof rc === 'string' ? Number(rc) : rc;
    if (!Number.isInteger(n) || n < 0 || n > RATING_COUNT_MAX) {
      problems.push({
        path: ['ratingCount'],
        message: `Rating count must be a whole number between 0 and ${RATING_COUNT_MAX.toLocaleString(
          'en-US'
        )} — got "${rc}".`,
      });
    }
  }

  const ra = data.ratingAverage;
  if (ra !== undefined && ra !== null && ra !== '') {
    const n = typeof ra === 'string' ? Number(ra) : ra;
    if (!Number.isFinite(n) || n < 0 || n > 5) {
      problems.push({
        path: ['ratingAverage'],
        message: `Rating average must be a number between 0 and 5 — got "${ra}".`,
      });
    }
  }
}

function checkFaqEnabled(data: any, problems: Problem[]): void {
  if (data.faqEnabled !== true) return;
  const faqs = data.faqs;
  if (!Array.isArray(faqs) || faqs.length === 0) {
    problems.push({
      path: ['faqs'],
      message: 'Add at least one FAQ, or turn "FAQ enabled" off.',
    });
  }
}

function checkBrandRequired(data: any, action: string, problems: Problem[]): void {
  // Enforce SEO on create always; on update only when the seo component is part
  // of the payload (a partial API update that omits it can't be judged here —
  // the admin edit form always sends the whole document).
  if (action !== 'create' && !('seo' in data)) return;
  const seo = data.seo ?? {};
  if (isBlank(seo.metaTitle)) {
    problems.push({ path: ['seo', 'metaTitle'], message: 'SEO title is required.' });
  }
  if (isBlank(seo.metaDescription)) {
    problems.push({
      path: ['seo', 'metaDescription'],
      message: 'SEO description is required.',
    });
  }
}

/**
 * Validate a taxonomy payload. No-op for any other content type. Throws
 * errors.ValidationError listing every problem (fields highlighted inline).
 */
export function validateEntityFields(uid: string, action: string, data: any): void {
  if (!ENTITY_UIDS.includes(uid as (typeof ENTITY_UIDS)[number])) return;
  if (!data || typeof data !== 'object') return;

  const problems: Problem[] = [];
  checkRatingRange(data, problems);
  checkFaqEnabled(data, problems);
  if (uid === 'api::brand.brand') checkBrandRequired(data, action, problems);

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
