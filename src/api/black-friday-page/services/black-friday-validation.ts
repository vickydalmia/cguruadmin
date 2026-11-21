import type { Problem } from '../../../utils/write-validation/problems';
import { toValidationError } from '../../../utils/write-validation/problems';

export function isSafeBlackFridayLink(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const href = value.trim();
  if (/^\/(?!\/)/u.test(href)) return !/[\\\s]/u.test(href);
  try { return ['https:', 'http:'].includes(new URL(href).protocol); } catch { return false; }
}

const LINK_FIELDS = [
  ['hero', 'primaryCtaHref'], ['hero', 'secondaryCtaHref'],
  ['topBrands', 'viewAllHref'], ['featured', 'viewAllHref'],
] as const;

export function blackFridayPageProblems(data: any): Problem[] {
  if (!data || typeof data !== 'object') return [];
  const problems: Problem[] = [];
  for (const [section, field] of LINK_FIELDS) {
    const value = data[section]?.[field];
    if (value && !isSafeBlackFridayLink(value)) problems.push({ path: [section, field], message: 'Use a root-relative path or an HTTP(S) URL.' });
  }
  const saleEndAt = data.hero?.saleEndAt;
  if (saleEndAt && !Number.isFinite(Date.parse(saleEndAt))) problems.push({ path: ['hero', 'saleEndAt'], message: 'Enter a valid sale end date and time.' });
  return problems;
}

export function validateBlackFridayPage(data: any): void {
  const problems = blackFridayPageProblems(data);
  if (problems.length) throw toValidationError(problems);
}
