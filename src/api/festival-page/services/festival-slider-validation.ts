import { relationKeys, resultingRelations, type RelationEntry } from '../../../utils/deal-of-the-day-validation';
import type { Problem } from '../../../utils/write-validation/problems';

function relations(incoming: unknown, stored: unknown): RelationEntry[] {
  const previous = relationKeys(stored).length ? [stored as RelationEntry] : [];
  if (incoming === undefined) return previous;
  return resultingRelations(incoming, previous) ?? (relationKeys(incoming).length ? [incoming as RelationEntry] : []);
}

export function festivalSlideProblems(incoming: any, stored: any, section = 'offerSlider', field = 'coupon'): Problem[] {
  if (!Array.isArray(incoming?.items)) return [];
  const problems: Problem[] = [];
  if (section === 'savingsSection' && incoming.items.length > 2) problems.push({ path: [section, 'items'], message: 'Select no more than 2 Coupons.' });
  incoming.items.forEach((item: any, index: number) => {
    const old = item?.id == null ? null : stored?.items?.find((row: any) => String(row.id) === String(item.id));
    if (relations(item?.[field], old?.[field]).length !== 1) {
      problems.push({ path: [section, 'items', index, field], message: field === 'deal' ? 'Select one Product Deal for this slide.' : 'Select one Coupon for this slide.' });
    }
  });
  return problems;
}
