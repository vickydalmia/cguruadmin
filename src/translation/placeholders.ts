// Placeholder preservation for HUMAN dictionary edits (Settings → UI Text).
// The LLM path has the stricter symmetric check in validate.ts; an editor's
// override or translation only has to KEEP what the English source carries
// — `{placeholders}`, URLs, e-mails, numbers — adding one is their call.
import { protectedValues } from './validate';

export type ProtectedValuesVerdict = { ok: boolean; missing: string[] };

/**
 * Multiset containment: every protected value of `source` must appear in
 * `translated` at least as often. `missing` lists what is absent, one entry
 * per missing occurrence, in source order — for the 400 the admin sees.
 */
export function keepsProtectedValues(
  source: string,
  translated: string,
): ProtectedValuesVerdict {
  const available = new Map<string, number>();
  for (const value of protectedValues(translated)) {
    available.set(value, (available.get(value) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const value of protectedValues(source)) {
    const left = available.get(value) ?? 0;
    if (left > 0) available.set(value, left - 1);
    else missing.push(value);
  }
  return { ok: missing.length === 0, missing };
}
