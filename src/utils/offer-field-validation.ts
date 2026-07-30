import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

// Rules for the offer text fields, enforced on coupon/deal create+update via
// the documents middleware, throwing the same ValidationError shape the
// homepage image check uses — so the admin highlights the field inline and
// shows a clear toast (details.errors[].path → inline error on that field).
//
// Two kinds of rule, both driven by the browser-safe tables in
// offer-word-limits.ts (shared with the Offer benefits admin panel, so hints
// can never drift from enforcement):
//   - offerText: free text capped by word count.
//   - cashbackText / bankOfferText / prepaidText: a BARE AMOUNT only ("10%",
//     "₹100", "Rs.100", "$40"). The public API appends the wording
//     ("Cashback" / "Bank OFF" / "Prepaid OFF") on the way out — see
//     src/utils/offer-text.ts — so editors never type it.
export { WORD_LIMITS, BENEFIT_TEXT_FIELDS } from './offer-word-limits';
import {
  BENEFIT_TEXT_FIELDS,
  WORD_LIMITS,
  isBenefitAmount,
} from './offer-word-limits';

const wordCount = (value: string): number =>
  value.trim().split(/\s+/).filter(Boolean).length;

type FieldRule = {
  field: string;
  /** Problem message for an invalid value, or null when the value passes. */
  problem: (value: string) => string | null;
};

const FIELD_RULES: FieldRule[] = [
  ...WORD_LIMITS.map(({ field, label, max }) => ({
    field,
    problem: (value: string) => {
      const count = wordCount(value);
      return count > max
        ? `${label} must be at most ${max} word${max === 1 ? '' : 's'} — got ${count} ("${value.trim()}").`
        : null;
    },
  })),
  ...BENEFIT_TEXT_FIELDS.map(({ field, label, suffix }) => ({
    field,
    problem: (value: string) =>
      isBenefitAmount(value)
        ? null
        : `${label} must be an amount only — a percent ("10%") or a currency amount ("₹100") — got "${value.trim()}". “${suffix}” is appended automatically on the site.`,
  })),
];

/**
 * Validate the offer/cashback/bank/prepaid text fields on a coupon or deal
 * payload. Only validates fields actually present on the payload (partial
 * updates skip absent fields). Throws errors.ValidationError listing every
 * problem.
 *
 * STRICT ("clean as you touch"): when `strict` is true the unchanged-value
 * grandfather below is disabled, so an invalid value re-saves as a failure
 * even when the editor left it exactly as the migrated row stored it. The
 * middleware sets `strict` only for human admin writes; the cron passes false
 * and keeps the grandfather, so a dirty untouched label never blocks it.
 */
export function validateOfferFields(
  data: any,
  action = 'create',
  stored: any = null,
  strict = false,
): void {
  if (!data || typeof data !== 'object') return;

  const problems: Array<{ path: string[]; message: string }> = [];

  for (const { field, problem } of FIELD_RULES) {
    const value = data[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const message = problem(value);
    if (message) {
      const normalized = (candidate: unknown) =>
        typeof candidate === 'string'
          ? candidate.trim().replace(/\s+/gu, ' ')
          : candidate;
      if (
        !strict &&
        action === 'update' &&
        stored &&
        normalized(value) === normalized(stored[field])
      ) {
        continue;
      }
      problems.push({ path: [field], message });
    }
  }

  if (problems.length) {
    const noun = problems.length === 1 ? 'problem' : 'problems';
    throw new errors.ValidationError(
      `Offer fields check failed (${problems.length} ${noun} — the fields are ` +
        `highlighted in the form):\n• ${problems
          .map((p) => `${p.path.join('.')}: ${p.message}`)
          .join('\n• ')}`,
      {
        // The admin edit view turns details.errors[].path into an inline error
        // on that exact field (same mechanism as the homepage image check).
        errors: problems.map((p) => ({
          path: p.path,
          message: p.message,
          name: 'ValidationError',
        })),
        // Previous shape, kept for non-admin API consumers.
        problems: problems.map((p) => `${p.path.join('.')}: ${p.message}`),
      }
    );
  }
}

export async function validateOfferFieldsForWrite(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: any,
  documentId?: string,
  strict = false,
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const isClone = action === 'clone';
  const touched = FIELD_RULES.filter(({ field }) =>
    Object.prototype.hasOwnProperty.call(data, field),
  );
  // Non-strict (the cron path): a partial write touching no validated label
  // costs nothing and cannot trip on a value it never sent. Strict validates
  // the whole effective record, so it must read stored even when nothing was
  // touched.
  if (!isClone && !strict && touched.length === 0) return;

  let stored: unknown = null;
  if ((action === 'update' || isClone) && documentId) {
    // Strict and clone both check the FULL record, so they need every
    // validated field pulled from the stored row; a non-strict update only
    // needs the touched ones for its grandfather comparison.
    const fields = isClone || strict ? FIELD_RULES : touched;
    stored = await strapi.documents(uid as any).findOne({
      documentId,
      fields: [
        'documentId',
        ...fields.map(({ field }) => field),
      ] as any,
    });
  }
  if (isClone && documentId && !stored) return;
  // Strict reuses the clone merge: payload over stored, so an absent field
  // falls back to its stored (possibly dirty) value and gets validated too.
  const effective =
    (isClone || strict) && stored && typeof stored === 'object'
      ? { ...stored, ...data }
      : data;
  validateOfferFields(effective, action, stored, strict);
}
