import { createHash } from 'node:crypto';
import type { TranslatableLeaf } from './field-map';

/**
 * Deterministic fingerprint of everything the LLM would be shown for one
 * entry. Same hash ⇒ the stored translation is current and the job no-ops
 * (idempotent backfill resume, edit-that-changed-nothing, relation-only
 * writes). Paths are already emitted in stable schema order by the walker;
 * sorting here makes the hash robust even if that ever changes.
 */
export function sourceContentHash(
  leaves: readonly TranslatableLeaf[],
  promptFingerprint = '',
): string {
  const canonical = JSON.stringify(
    {
      promptFingerprint,
      leaves: [...leaves]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((leaf) => [leaf.path, leaf.kind, leaf.maxLength ?? null, leaf.value]),
    },
  );
  return createHash('sha256').update(canonical).digest('hex');
}
