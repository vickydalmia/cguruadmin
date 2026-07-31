import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

// Rules for the offer text fields, enforced on coupon/deal create+update via
// the documents middleware, throwing the same ValidationError shape the
// homepage image check uses — so the admin highlights the field inline and
// shows a clear toast (details.errors[].path → inline error on that field).
//
// These rules are driven by the browser-safe tables in
// offer-word-limits.ts (shared with the Offer benefits admin panel, so hints
// can never drift from enforcement):
//   - Coupon offerText: free text capped by word count. Product Deals do not
//     carry this field; their promotional label is `discount`.
//   - Deal discount: a controlled prefix paired with a bare amount.
//   - cashbackText / bankOfferText / prepaidText: a BARE AMOUNT only ("10%",
//     "₹100", "Rs.100", "$40"). The public API appends the wording
//     ("Cashback" / "Bank OFF" / "Prepaid OFF") on the way out — see
//     src/utils/offer-text.ts — so editors never type it.
export { WORD_LIMITS, BENEFIT_TEXT_FIELDS } from './offer-word-limits';
import {
  BENEFIT_TEXT_FIELDS,
  WORD_LIMITS,
  isOfferAmount,
} from './offer-word-limits';
import { isDealDiscountPrefix } from './deal-discount';

const wordCount = (value: string): number =>
  value.trim().split(/\s+/).filter(Boolean).length;

type FieldRule = {
  field: string;
  /** Problem message for an invalid value, or null when the value passes. */
  problem: (value: string) => string | null;
};

const WORD_FIELD_RULES: FieldRule[] = WORD_LIMITS.map(({ field, label, max }) => ({
    field,
    problem: (value: string) => {
      const count = wordCount(value);
      return count > max
        ? `${label} must be at most ${max} word${max === 1 ? '' : 's'} — got ${count} ("${value.trim()}").`
        : null;
    },
  }));

const BENEFIT_FIELD_RULES: FieldRule[] = BENEFIT_TEXT_FIELDS.map(
  ({ field, label, suffix }) => ({
    field,
    problem: (value: string) =>
      isOfferAmount(value)
        ? null
        : `${label} must be an amount only — a percent ("10%") or a currency amount ("₹100") — got "${value.trim()}". “${suffix}” is appended automatically on the site.`,
  }),
);

const DEAL_UID = 'api::deal.deal';
const DEAL_DISCOUNT_FIELDS = ['discount', 'discountPrefix'] as const;
const DEAL_DISCOUNT_FIELD_SET = new Set<string>(DEAL_DISCOUNT_FIELDS);
const DEAL_DISCOUNT_RULE: FieldRule = {
  field: 'discount',
  problem: (value: string) =>
    isOfferAmount(value)
      ? null
      : `Discount must be an amount only — a percent ("10%") or a currency amount ("₹100") — got "${value.trim()}". The selected prefix and “OFF” are assembled automatically on the site.`,
};

function fieldRulesForUid(uid?: string): FieldRule[] {
  return uid === DEAL_UID
    ? [...BENEFIT_FIELD_RULES, DEAL_DISCOUNT_RULE]
    : [...WORD_FIELD_RULES, ...BENEFIT_FIELD_RULES];
}

function fieldNamesForUid(uid?: string): string[] {
  const fields = fieldRulesForUid(uid).map(({ field }) => field);
  if (uid === DEAL_UID) fields.push('discountPrefix');
  return fields;
}

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
  uid?: string,
): void {
  if (!data || typeof data !== 'object') return;

  const problems: Array<{ path: string[]; message: string }> = [];
  const normalized = (candidate: unknown) =>
    typeof candidate === 'string'
      ? candidate.trim().replace(/\s+/gu, ' ')
      : candidate;
  const unchanged = (fields: readonly string[]) =>
    !strict &&
    action === 'update' &&
    stored &&
    fields.every((field) => normalized(data[field]) === normalized(stored[field]));
  const addProblem = (
    path: string[],
    message: string,
    comparisonFields: readonly string[] = path,
  ) => {
    if (!unchanged(comparisonFields)) problems.push({ path, message });
  };

  for (const { field, problem } of fieldRulesForUid(uid)) {
    const value = data[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const message = problem(value);
    if (message) {
      // The Deal discount amount is grandfathered only while the WHOLE pair is
      // untouched — otherwise a prefix-only write could pair a valid prefix
      // with a stored non-amount discount, a state the pair rules forbid.
      addProblem(
        [field],
        message,
        uid === DEAL_UID && DEAL_DISCOUNT_FIELD_SET.has(field)
          ? DEAL_DISCOUNT_FIELDS
          : [field],
      );
    }
  }

  if (uid === DEAL_UID) {
    const discount = data.discount;
    const discountPrefix = data.discountPrefix;
    const hasDiscount = typeof discount === 'string' && discount.trim() !== '';
    const hasPrefix = typeof discountPrefix === 'string' && discountPrefix.trim() !== '';

    if (hasDiscount && !hasPrefix) {
      addProblem(
        ['discountPrefix'],
        'Discount prefix is required when a discount amount is entered.',
        DEAL_DISCOUNT_FIELDS,
      );
    }
    if (hasPrefix && !hasDiscount) {
      addProblem(
        ['discount'],
        'Discount amount is required when a discount prefix is selected.',
        DEAL_DISCOUNT_FIELDS,
      );
    }
    if (hasPrefix && !isDealDiscountPrefix(discountPrefix)) {
      addProblem(
        ['discountPrefix'],
        `Discount prefix "${discountPrefix}" is not supported.`,
        DEAL_DISCOUNT_FIELDS,
      );
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
  const applicableFields = fieldNamesForUid(uid);
  const touched = applicableFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(data, field),
  );
  // Non-strict (the cron path): a partial write touching no validated label
  // costs nothing and cannot trip on a value it never sent. Strict validates
  // the whole effective record, so it must read stored even when nothing was
  // touched.
  if (!isClone && !strict && touched.length === 0) return;

  let stored: unknown = null;
  const needsDealPairContext =
    uid === DEAL_UID && touched.some((field) => DEAL_DISCOUNT_FIELD_SET.has(field));
  if ((action === 'update' || isClone) && documentId) {
    // Strict and clone both check the FULL record, so they need every
    // validated field pulled from the stored row; a non-strict update only
    // needs the touched ones for its grandfather comparison.
    const fields =
      isClone || strict
        ? applicableFields
        : needsDealPairContext
          ? [...new Set([...touched, ...DEAL_DISCOUNT_FIELDS])]
          : touched;
    stored = await strapi.documents(uid as any).findOne({
      documentId,
      fields: [
        'documentId',
        ...fields,
      ] as any,
    });
  }
  if (isClone && documentId && !stored) return;
  // Strict reuses the clone merge: payload over stored, so an absent field
  // falls back to its stored (possibly dirty) value and gets validated too.
  const effective =
    (isClone || strict || needsDealPairContext) && stored && typeof stored === 'object'
      ? { ...stored, ...data }
      : data;
  validateOfferFields(effective, action, stored, strict, uid);
}
