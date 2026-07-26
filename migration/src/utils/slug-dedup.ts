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

/**
 * Replay already-completed rows before an interrupted taxonomy run resumes.
 * Order matters because each collision consumes the next numeric suffix.
 */
export function primeSlugTracker(
  entries: Iterable<{ slug: string; table: string }>,
): void {
  for (const entry of entries) {
    deduplicateSlug(entry.slug, entry.table);
  }
}

export function resetSlugTracker(): void {
  usedSlugs.clear();
}
