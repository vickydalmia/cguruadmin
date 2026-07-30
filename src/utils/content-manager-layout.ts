// Pure helpers for the content-manager view configuration pinned in
// src/index.ts. The shapes here mirror what
// `plugin('content-manager').service('content-types')` stores in the DB
// config store: `layouts.edit` is rows of `{ name, size }` cells, `layouts.list`
// is an array of attribute names.

/** One field in an edit-view row. `size` is a column count out of MAX_ROW_SIZE. */
export type EditCell = { name: string; size: number };

/** Edit-view layout: an ordered list of rows, each an ordered list of cells. */
export type EditLayout = EditCell[][];

/** An edit-view row is 12 columns wide (content-manager's MAX_ROW_SIZE). */
export const MAX_ROW_SIZE = 12;

/**
 * Remove named fields from an edit layout without disturbing the order or
 * width of any remaining field. Returns `null` when the layout is already in
 * the requested state so bootstrap callers can avoid redundant config writes.
 */
export function removeEditLayoutFields(
  edit: EditLayout,
  names: readonly string[],
): EditLayout | null {
  const hidden = new Set(names);
  const next = edit
    .map((row) => row.filter((cell) => !hidden.has(cell.name)))
    .filter((row) => row.length > 0);

  return JSON.stringify(next) === JSON.stringify(edit) ? null : next;
}

// Mirrored from @strapi/content-manager 5.50
// (server/src/services/utils/configuration/attributes.ts). The admin can only
// sort by a column that is displayed, and it renders a sort control only when
// the attribute type is sortable — so a "please let me sort by X" fix means
// adding X to layouts.list, and X must pass BOTH lists below.
const NON_SORTABLE_TYPES = new Set([
  'component',
  'json',
  'media',
  'richtext',
  'dynamiczone',
  'blocks',
]);
const NON_LISTABLE_TYPES = new Set(['json', 'password', 'richtext', 'dynamiczone', 'blocks']);
const SORTABLE_RELATION_TYPES = new Set(['oneToOne', 'manyToOne']);

/**
 * True when an attribute may be shown as a list column AND clicked to sort.
 * Relations are the asymmetric case: many-to-many is listable but never
 * sortable, so requiring both is stricter than either check alone.
 */
export function isSortableListColumn(attribute: any): boolean {
  const type = attribute?.type;
  if (typeof type !== 'string') return false;
  if (NON_SORTABLE_TYPES.has(type) || NON_LISTABLE_TYPES.has(type)) return false;
  if (type === 'relation') return SORTABLE_RELATION_TYPES.has(attribute.relationType);
  return true;
}

/**
 * Give `name` a whole row of the edit form, keeping every other field.
 * The rest of its row is pushed down into a new row directly below rather
 * than repacked globally — unrelated rows an editor arranged by hand stay
 * exactly as they were.
 *
 * Returns `null` when there is nothing to do: either the field already owns
 * its row, or it is absent from the layout (deliberately hidden fields must
 * not be resurrected — see hideRelationsFromContentManager).
 */
export function pinFieldToFullRow(edit: EditLayout, name: string): EditLayout | null {
  const rowIndex = edit.findIndex((row) => row.some((cell) => cell?.name === name));
  if (rowIndex === -1) return null;

  const row = edit[rowIndex];
  const cell = row.find((c) => c.name === name)!;
  if (row.length === 1 && cell.size === MAX_ROW_SIZE) return null;

  const displaced = row.filter((c) => c.name !== name);
  return [
    ...edit.slice(0, rowIndex),
    [{ ...cell, size: MAX_ROW_SIZE }],
    ...(displaced.length ? [displaced] : []),
    ...edit.slice(rowIndex + 1),
  ];
}

/**
 * Append the columns that are not displayed yet, preserving the existing
 * order. Returns `null` when every column is already present, so the caller
 * can skip the write and stay idempotent across restarts.
 */
export function appendListColumns(list: string[], columns: string[]): string[] | null {
  const present = new Set(list);
  const missing: string[] = [];
  for (const column of columns) {
    if (present.has(column)) continue;
    present.add(column);
    missing.push(column);
  }
  return missing.length ? [...list, ...missing] : null;
}
