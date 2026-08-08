/**
 * Bridge between the Taxonomies side panel and the checkout-merchant input.
 *
 * The two live in separate React trees (a side panel vs the edit form's
 * InputRenderer), so the panel's "an affiliate brand is selected" state
 * cannot flow down as props. Module-scoped state is the established pattern
 * for cross-tree admin coordination here (record-lock's lease interceptor),
 * and both trees ship in the same admin bundle.
 *
 * Keyed by model + documentId so a stale entry from one record can never
 * disable the dropdown on another. Consumers read through
 * React.useSyncExternalStore; snapshots are referentially stable until the
 * published value actually changes.
 */

export type AffiliateEntryState = {
  /** True while the panel considers the checkout merchant un-editable. */
  blocked: boolean;
  /** Names of the selected affiliate brand(s), for the input's hint. */
  brandNames: readonly string[];
};

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
  a.brandNames.every((name, index) => name === b.brandNames[index]);

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

/** Called when the publishing panel unmounts, so no stale block survives. */
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
