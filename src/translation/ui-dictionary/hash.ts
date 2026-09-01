import { createHash } from 'node:crypto';

/**
 * Fingerprint of one catalogue entry's translation SOURCE: the English text
 * and its declared length budget — nothing else. The prompt fingerprint is
 * deliberately excluded (see the migration header): a prompt tweak must never
 * make a manual translation look stale.
 */
export function catalogueEntryHash(
  text: string,
  maxLength?: number | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([text, maxLength ?? null]))
    .digest('hex');
}

export type CatalogueVersionEntry = {
  text: string;
  description?: string;
  maxLength?: number;
  pluralOf?: string;
};

/**
 * Deterministic version of a whole catalogue (key-sorted). The storefront
 * sends its own version with every push; this exists so any side can derive
 * the same value from the same entries (tests, seeds, re-pushes).
 */
export function catalogueVersion(
  entries: Record<string, CatalogueVersionEntry>,
): string {
  const canonical = Object.keys(entries)
    .sort()
    .map((key) => {
      const entry = entries[key];
      return [
        key,
        entry.text,
        entry.description ?? null,
        entry.maxLength ?? null,
        entry.pluralOf ?? null,
      ];
    });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
