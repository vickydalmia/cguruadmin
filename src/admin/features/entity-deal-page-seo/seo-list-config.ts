// List configuration for the Deal-page SEO screen: page sizing, status
// variants, column definitions and row shaping.
import { type StatusVariant } from '@strapi/design-system';

import type { EntityDealPageRow, IndexState } from './types';

export const DEFAULT_PAGE_SIZE = 25;
// 25 must appear here or the page-size select would render a value it has no
// option for. The rest mirror Strapi's own defaults.
export const PAGE_SIZE_OPTIONS = ['10', '25', '50', '100'];

export const STATUS_VARIANT: Record<IndexState, StatusVariant> = {
  enabled: 'success',
  // "Off" is a deliberate editorial choice, "Blocked" means the editor asked
  // for indexing and something is preventing it — only the latter is a problem.
  disabled: 'secondary',
  blocked: 'danger',
};

/**
 * Column definitions. `name` doubles as the sort key sent to the server, so the
 * sortable entries must match SORT_FIELDS in `../api` (and SETTINGS_SORT_FIELDS
 * in the entity-deal-page service).
 */
export const HEADERS: { name: string; label: string; sortable: boolean }[] = [
  { name: 'name', label: 'Entity', sortable: true },
  { name: 'permalink', label: 'Permalink', sortable: false },
  { name: 'liveDealCount', label: 'Live Deals', sortable: true },
  { name: 'indexState', label: 'Index state', sortable: false },
  { name: 'updatedAt', label: 'Updated', sortable: true },
  { name: 'actions', label: 'Actions', sortable: false },
];

export type ListQueryParams = {
  page?: string;
  pageSize?: string;
  sort?: string;
  kind?: string;
  indexState?: string;
  _q?: string;
};

/**
 * `Table.Root` requires an `id` on every row, but the entity's own numeric `id`
 * is only unique within one content type and this list mixes all four. Carry a
 * composite key beside the row rather than overwriting it.
 */
export type TableRow = { id: string; row: EntityDealPageRow };

export function formatUpdatedAt(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}
