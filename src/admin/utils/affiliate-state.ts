export type BrandRef = { documentId: string; name: string };

export type AffiliateEntryState = {
  blocked: boolean;
  brandNames: readonly string[];
  /**
   * The selected affiliate brand(s). While `blocked`, the merchant input
   * RESTRICTS its options to these instead of hard-disabling — clearing the
   * field and pointing it at the affiliate brand itself stay reachable, the
   * two edits the server accepts in that state. Empty while blocked means
   * "state unknown, still resolving" → the input hard-disables.
   */
  brandRefs: ReadonlyArray<BrandRef>;
};

/**
 * First occurrence wins. The selection list CAN carry a duplicate documentId
 * (the paginated relation load merges pages of an unstably-sorted endpoint
 * without deduplicating), and any id/name re-pairing done over a deduplicated
 * id list against a NON-deduplicated name list mislabels every ref after the
 * duplicate — so dedupe the PAIRS, never the halves.
 */
export function dedupeBrandRefs(
  refs: ReadonlyArray<BrandRef>,
): BrandRef[] {
  const seen = new Set<string>();
  const result: BrandRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.documentId)) continue;
    seen.add(ref.documentId);
    result.push(ref);
  }
  return result;
}

const states = new Map<string, AffiliateEntryState>();
const listeners = new Set<() => void>();

const keyFor = (model: string, documentId?: string): string =>
  `${model}:${documentId ?? 'new'}`;

const sameState = (
  a: AffiliateEntryState | undefined,
  b: AffiliateEntryState,
): boolean =>
  !!a &&
  a.blocked === b.blocked &&
  a.brandNames.length === b.brandNames.length &&
  a.brandNames.every((name, index) => name === b.brandNames[index]) &&
  a.brandRefs.length === b.brandRefs.length &&
  a.brandRefs.every(
    (ref, index) =>
      ref.documentId === b.brandRefs[index].documentId &&
      ref.name === b.brandRefs[index].name,
  );

export function publishAffiliateState(
  model: string,
  documentId: string | undefined,
  state: AffiliateEntryState,
): void {
  const key = keyFor(model, documentId);
  if (sameState(states.get(key), state)) return;
  states.set(key, state);
  for (const listener of listeners) listener();
}

export function clearAffiliateState(
  model: string,
  documentId: string | undefined,
): void {
  const key = keyFor(model, documentId);
  if (!states.delete(key)) return;
  for (const listener of listeners) listener();
}

export function subscribeAffiliateState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAffiliateState(
  model: string,
  documentId: string | undefined,
): AffiliateEntryState | undefined {
  return states.get(keyFor(model, documentId));
}
