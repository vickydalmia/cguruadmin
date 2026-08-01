export function orderedUniqueTermIds({
  termIds,
}: {
  termIds: readonly number[];
}): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const termId of termIds) {
    if (!termId || seen.has(termId)) continue;
    seen.add(termId);
    ordered.push(termId);
  }
  return ordered;
}

export function shouldLinkLogoStore({
  onlyWithoutStore,
  storeIds,
}: {
  onlyWithoutStore?: boolean;
  storeIds: readonly number[];
}): boolean {
  return !onlyWithoutStore || storeIds.length === 0;
}
