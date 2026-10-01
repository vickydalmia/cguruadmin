type Relation = { id?: number; documentId?: string; title?: string; label?: string };
type Selection = { connect?: Relation[]; disconnect?: Relation[] };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Read-only editor label; never copy the Coupon title into a storefront override. */
export function festivalSlideTitle(override: unknown, selection: Selection | undefined, saved: Relation[] = []): string {
  const custom = text(override);
  if (custom) return custom;
  const removed = selection?.disconnect ?? [];
  const available = [...(selection?.connect ?? []).toReversed(), ...saved].filter((item) =>
    !removed.some((other) => (item.documentId && item.documentId === other.documentId) || (item.id != null && item.id === other.id)));
  const selected = available[0];
  return text(selected?.title) || text(selected?.label) || 'Select a Coupon';
}
