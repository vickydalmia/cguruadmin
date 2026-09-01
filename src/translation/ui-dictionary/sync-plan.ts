// Pure diff of a pushed catalogue against the stored one. The store runs the
// resulting upserts/removals inside one locked transaction (store.ts).
import { catalogueEntryHash } from './hash';
import type { CatalogueEntryInput, CatalogueRow } from './types';

export type ExistingCatalogueRow = Pick<
  CatalogueRow,
  'key' | 'hash' | 'overrideText' | 'removedAt'
>;

/** Snake-case row for `ui_catalogue` insert … ON CONFLICT (key) DO UPDATE. */
export type CatalogueUpsertRow = {
  key: string;
  text: string;
  description: string | null;
  max_length: number | null;
  plural_of: string | null;
  hash: string;
  override_text: string | null;
  effective_hash: string;
  first_seen_at: Date;
  last_seen_at: Date;
  removed_at: null;
};

/** Columns refreshed on conflict — the override columns are NOT among them. */
export const CATALOGUE_MERGE_COLUMNS = [
  'text',
  'description',
  'max_length',
  'plural_of',
  'hash',
  'effective_hash',
  'last_seen_at',
  'removed_at',
] as const;

export type CatalogueSyncPlan = {
  upserts: CatalogueUpsertRow[];
  added: string[];
  changed: string[];
  /** Previously removed keys pushed again. */
  revived: string[];
  /** Live keys the push no longer contains. */
  removed: string[];
};

export function planCatalogueSync(
  existing: readonly ExistingCatalogueRow[],
  entries: Record<string, CatalogueEntryInput>,
  now: Date,
): CatalogueSyncPlan {
  const existingByKey = new Map(existing.map((row) => [row.key, row]));
  const plan: CatalogueSyncPlan = {
    upserts: [],
    added: [],
    changed: [],
    revived: [],
    removed: [],
  };
  for (const key of Object.keys(entries).sort()) {
    const entry = entries[key];
    const previous = existingByKey.get(key);
    const maxLength = entry.maxLength ?? null;
    const hash = catalogueEntryHash(entry.text, maxLength);
    // An English override outlives a source change: the admin's text is
    // still what the UI shows, so `effective_hash` keeps following it.
    const overrideText = previous?.overrideText ?? null;
    plan.upserts.push({
      key,
      text: entry.text,
      description: entry.description ?? null,
      max_length: maxLength,
      plural_of: entry.pluralOf ?? null,
      hash,
      override_text: overrideText,
      effective_hash: catalogueEntryHash(overrideText ?? entry.text, maxLength),
      first_seen_at: now,
      last_seen_at: now,
      removed_at: null,
    });
    if (!previous) plan.added.push(key);
    else if (previous.hash !== hash) plan.changed.push(key);
    else if (previous.removedAt) plan.revived.push(key);
  }
  for (const row of existing) {
    if (!row.removedAt && entries[row.key] === undefined) {
      plan.removed.push(row.key);
    }
  }
  plan.removed.sort();
  return plan;
}
