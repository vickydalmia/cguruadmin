import { createHash } from 'node:crypto';
import type { TranslatableLeaf } from './field-map';

/** Paths include component positions: a reorder is reused only on an exact match. */
export function fieldFingerprints(leaves: readonly TranslatableLeaf[], prompt: string): Record<string, string> {
  return Object.fromEntries(leaves.map((leaf) => [leaf.path,
    createHash('sha256').update(JSON.stringify([prompt, leaf])).digest('hex'),
  ]));
}

export function selectTranslationFields(
  leaves: readonly TranslatableLeaf[],
  fingerprints: Record<string, string>,
  previous: Record<string, string> | null | undefined,
  memory: Record<string, string> | null | undefined,
  force: boolean,
) {
  const reused = new Map<string, string>();
  const changed = leaves.filter((leaf) => {
    const value = memory?.[leaf.path];
    if (!force && previous?.[leaf.path] === fingerprints[leaf.path] && value?.trim()) {
      reused.set(leaf.path, value);
      return false;
    }
    return true;
  });
  return { changed, reused };
}
