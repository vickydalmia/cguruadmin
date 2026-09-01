// Pure client-side filtering of the dictionary rows (the server returns the
// whole catalogue for one locale; ≤ 5,000 rows).
import { ENGLISH_CODE, type EntryStatus, type UiDictionaryEntry } from './types';

export type EntryFilters = {
  search: string;
  status: string;
  namespace: string;
  showRemoved: boolean;
};

export type StatusOption = { value: EntryStatus; label: string };

const ENGLISH_STATUSES: StatusOption[] = [
  { value: 'source', label: 'Catalogue English' },
  { value: 'override', label: 'Overridden' },
];

const TARGET_STATUSES: StatusOption[] = [
  { value: 'missing', label: 'Missing' },
  { value: 'stale', label: 'Out of date' },
  { value: 'ai', label: 'AI translated' },
  { value: 'manual', label: 'Manual' },
];

export function statusOptionsFor(locale: string): StatusOption[] {
  return locale === ENGLISH_CODE ? ENGLISH_STATUSES : TARGET_STATUSES;
}

/** `offers.count.other` → `offers`. */
export function namespaceOf(key: string): string {
  const dot = key.indexOf('.');
  return dot > 0 ? key.slice(0, dot) : key;
}

export function namespacesOf(entries: readonly UiDictionaryEntry[]): string[] {
  return [...new Set(entries.map((entry) => namespaceOf(entry.key)))].sort();
}

function matchesSearch(entry: UiDictionaryEntry, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    entry.key,
    entry.source.effectiveText,
    entry.source.text,
    entry.translation?.text ?? '',
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

export function filterEntries(
  entries: readonly UiDictionaryEntry[],
  filters: EntryFilters,
): UiDictionaryEntry[] {
  const needle = filters.search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!filters.showRemoved && entry.source.removedAt) return false;
    if (filters.namespace && namespaceOf(entry.key) !== filters.namespace) return false;
    if (filters.status && entry.status !== filters.status) return false;
    return matchesSearch(entry, needle);
  });
}

export function countByStatus(
  entries: readonly UiDictionaryEntry[],
): Partial<Record<EntryStatus, number>> {
  const counts: Partial<Record<EntryStatus, number>> = {};
  for (const entry of entries) {
    if (entry.source.removedAt) continue;
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}
