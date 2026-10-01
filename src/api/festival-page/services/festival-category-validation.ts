import { relationKeys, resultingRelations, type RelationEntry } from '../../../utils/deal-of-the-day-validation';
import type { Problem } from '../../../utils/write-validation/problems';

export function festivalCategoryProblems(incoming: any, stored: any): Problem[] {
  if (!Array.isArray(incoming?.categories)) return [];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  incoming.categories.forEach((row: any, index: number) => {
    const old = stored?.categories?.find((item: any) => row.id != null && String(item.id) === String(row.id));
    const previous = old?.category ? [old.category] : [];
    const selected = row.category === undefined ? previous
      : resultingRelations(row.category, previous) ?? (relationKeys(row.category).length ? [row.category as RelationEntry] : []);
    const path = ['exploreCategories', 'categories', index, 'category'];
    if (selected.length !== 1) problems.push({ path, message: 'Select one Category.' });
    else {
      const keys = relationKeys(selected[0]);
      if (keys.some((key) => seen.has(key))) problems.push({ path, message: 'This category is already selected. Choose each category once.' });
      keys.forEach((key) => seen.add(key));
    }
  });
  return problems;
}
