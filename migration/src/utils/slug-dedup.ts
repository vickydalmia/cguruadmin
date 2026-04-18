const usedSlugs = new Map<string, Set<string>>();

export function deduplicateSlug(slug: string, table: string): string {
  if (!usedSlugs.has(table)) {
    usedSlugs.set(table, new Set());
  }
  const set = usedSlugs.get(table)!;

  let candidate = slug;
  let counter = 1;
  while (set.has(candidate)) {
    candidate = `${slug}-${counter}`;
    counter++;
  }
  set.add(candidate);
  return candidate;
}

export function resetSlugTracker(): void {
  usedSlugs.clear();
}
