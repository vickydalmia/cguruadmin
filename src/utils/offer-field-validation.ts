import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

// The offer badge and pill texts are short by design and drive fixed-size card
// slots, so cap their word counts. Enforced on coupon/deal create+update via
// the documents middleware, throwing the same ValidationError shape the
// homepage image check uses — so the admin highlights the field inline and
// shows a clear toast (details.errors[].path → inline error on that field).
// Exported so the editor-facing word-cap hints in index.ts derive from the SAME
// table the validator enforces — the hint's number can never drift from the cap.
export const WORD_LIMITS: Array<{ field: string; label: string; max: number }> = [
  { field: 'offerText', label: 'Offer text', max: 3 },
  { field: 'cashbackText', label: 'Cashback text', max: 2 },
  { field: 'bankOfferText', label: 'Bank offer text', max: 3 },
];

const wordCount = (value: string): number =>
  value.trim().split(/\s+/).filter(Boolean).length;

/**
 * Validate the offer/cashback/bank text fields on a coupon or deal payload.
 * Only validates fields actually present on the payload (partial updates skip
 * absent fields). Throws errors.ValidationError listing every problem.
 *
 * STRICT ("clean as you touch"): when `strict` is true the unchanged-value
 * grandfather below is disabled, so an over-limit value re-saves as a failure
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

  for (const { field, label, max } of WORD_LIMITS) {
    const value = data[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const count = wordCount(value);
    if (count > max) {
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
      problems.push({
        path: [field],
        message: `${label} must be at most ${max} word${max === 1 ? '' : 's'} — got ${count} ("${value.trim()}").`,
      });
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
  const touched = WORD_LIMITS.filter(({ field }) =>
    Object.prototype.hasOwnProperty.call(data, field),
  );
  // Non-strict (the cron path): a partial write touching no capped label costs
  // nothing and cannot trip on a value it never sent. Strict validates the
  // whole effective record, so it must read stored even when nothing was
  // touched.
  if (!isClone && !strict && touched.length === 0) return;

  let stored: unknown = null;
  if ((action === 'update' || isClone) && documentId) {
    // Strict and clone both check the FULL record, so they need every capped
    // field pulled from the stored row; a non-strict update only needs the
    // touched ones for its grandfather comparison.
    const fields = isClone || strict ? WORD_LIMITS : touched;
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
