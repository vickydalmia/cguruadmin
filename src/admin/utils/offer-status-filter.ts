/**
 * Query-shape helpers behind the Published / Scheduled / Expired tabs on the
 * Coupon and Product Deal list views (src/admin/components/offer-status-tabs.tsx).
 *
 * The tabs are a shortcut for a filter the editor could build by hand, NOT a
 * parallel mechanism. Strapi's own filter UI reads and writes
 * `query.filters.$and` as a flat array of single-key clauses (see
 * `@strapi/admin` components/Filters.mjs), so writing the same shape here means
 * the two stay in sync in both directions: picking a tab shows a matching
 * filter chip, and removing that chip deselects the tab.
 *
 * React-free on purpose — the shape logic is the part worth testing.
 */

export const OFFER_STATUS_TAB_IDS = ['all', 'published', 'scheduled', 'expired'] as const;

export type OfferStatusTab = (typeof OFFER_STATUS_TAB_IDS)[number];

export const OFFER_STATUS_TABS: Array<{ id: OfferStatusTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'published', label: 'Published' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'expired', label: 'Expired' },
];

/** Content types that carry the derived `contentStatus` lifecycle field. */
const OFFER_MODELS = new Set(['api::coupon.coupon', 'api::deal.deal']);

export function isOfferModel(model: unknown): boolean {
  return typeof model === 'string' && OFFER_MODELS.has(model);
}

const STATUS_FIELD = 'contentStatus';

type Clause = Record<string, any>;
type QueryFilters = { $and?: Clause[] } & Record<string, any>;

function clauses(filters: unknown): Clause[] {
  const list = (filters as QueryFilters | undefined)?.$and;
  return Array.isArray(list) ? list : [];
}

const isStatusClause = (clause: Clause): boolean =>
  Boolean(clause) && typeof clause === 'object' && STATUS_FIELD in clause;

/**
 * The tab implied by the current query. A clause the tabs did not write (an
 * `$ne`, or an `$eq` on a value outside the enum) is NOT claimed by any tab —
 * returning 'all' there would render a selected "All" tab next to a filter chip
 * that is plainly narrowing the list. Callers should treat a null result as
 * "no tab selected".
 */
export function readStatusTab(filters: unknown): OfferStatusTab | null {
  const status = clauses(filters).filter(isStatusClause);
  if (status.length === 0) return 'all';
  // Two conflicting status clauses can only come from hand-built filters, and
  // they narrow to an empty set — no tab represents that.
  if (status.length > 1) return null;

  const value = status[0]?.[STATUS_FIELD]?.$eq;
  return OFFER_STATUS_TAB_IDS.includes(value as OfferStatusTab) && value !== 'all'
    ? (value as OfferStatusTab)
    : null;
}

/**
 * The `filters` object for a tab click: every clause the editor set by hand is
 * preserved, only the status clause is swapped. Returns `undefined` when the
 * result is empty so the key drops out of the URL entirely rather than
 * lingering as `filters[$and]=`.
 */
export function withStatusTab(
  filters: unknown,
  tab: OfferStatusTab,
): QueryFilters | undefined {
  const rest = (filters ?? {}) as QueryFilters;
  const kept = clauses(filters).filter((clause) => !isStatusClause(clause));
  const next =
    tab === 'all' ? kept : [...kept, { [STATUS_FIELD]: { $eq: tab } }];

  const { $and: _dropped, ...others } = rest;
  if (next.length === 0) {
    return Object.keys(others).length > 0 ? others : undefined;
  }
  return { ...others, $and: next };
}
