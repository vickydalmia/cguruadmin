import { errors } from '@strapi/utils';

// The offer badge and pill texts are short by design and drive fixed-size card
// slots, so cap their word counts. Enforced on coupon/deal create+update via
// the documents middleware, throwing the same ValidationError shape the
// homepage image check uses — so the admin highlights the field inline and
// shows a clear toast (details.errors[].path → inline error on that field).
const WORD_LIMITS: Array<{ field: string; label: string; max: number }> = [
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
 */
export function validateOfferFields(data: any): void {
  if (!data || typeof data !== 'object') return;

  const problems: Array<{ path: string[]; message: string }> = [];

  for (const { field, label, max } of WORD_LIMITS) {
    const value = data[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const count = wordCount(value);
    if (count > max) {
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
