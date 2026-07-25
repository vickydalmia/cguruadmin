export function orderedUniqueTermIds({
  termIds,
  primaryTermId,
  acfStoreTermId,
}: {
  termIds: readonly number[];
  primaryTermId?: number;
  acfStoreTermId?: number | null;
}): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const termId of [acfStoreTermId, primaryTermId, ...termIds]) {
    if (!termId || seen.has(termId)) continue;
    seen.add(termId);
    ordered.push(termId);
  }
  return ordered;
}
