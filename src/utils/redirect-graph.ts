// The active-redirect graph for the redirect validator: loading the edge
// map, walking chains for loops and over-long paths, and duplicate-`from`
// detection. Split out of redirect-validation.ts, which keeps the write
// orchestration.
import type { Core } from '@strapi/strapi';
import { classifyTarget } from './redirect-targets';
import { foldPathKey, normalizeRedirectPath } from './redirect-paths';
import { readString } from './row-fields';

export const REDIRECT_UID = 'api::redirect.redirect';

/**
 * Must equal MAX_REDIRECT_HOPS in
 * cguru-ui/src/features/routing/api/get-redirects.ts. What an editor can save
 * is then exactly what the resolver can follow to the end — a chain longer
 * than the resolver's budget would silently land the visitor on an
 * intermediate hop instead of the destination the editor authored.
 */
export const REDIRECT_MAX_HOPS = 5;

// Ceiling on active redirects, enforced at write (guard 2b) AND the bound on
// the cycle-walk graph load. It must not exceed what the frontend resolver can
// page in (MAX_REDIRECT_PAGES × 100 = 2000 in get-redirects.ts): a rule beyond
// that is saved but never executes and can hide a cycle from the walk. Redirect
// tables are small (tens to low hundreds) in practice; this only matters if one
// grows pathologically.
export const ACTIVE_REDIRECT_LIMIT = 2000;

export type Edge = { fromPath: string; toPath: string | null; note: string };

/**
 * The active redirect graph, keyed by folded `from`. The row being edited is
 * excluded so the pending version replaces it rather than racing it.
 *
 * An external target is stored as `toPath: null` — the chain ends there and
 * cannot loop back into this site.
 */
export async function loadActiveEdges(
  strapi: Core.Strapi,
  excludeDocumentId: string | undefined,
): Promise<Map<string, Edge>> {
  const rows: unknown = await strapi.documents(REDIRECT_UID as any).findMany({
    filters: { active: true } as any,
    fields: ['documentId', 'from', 'to'] as any,
    limit: ACTIVE_REDIRECT_LIMIT,
  });

  const edges = new Map<string, Edge>();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (excludeDocumentId && readString(row, 'documentId') === excludeDocumentId) continue;

    const fromPath = normalizeRedirectPath(readString(row, 'from'));
    if (!fromPath) continue;

    const target = classifyTarget(readString(row, 'to'));
    // A stored row with an unusable target cannot participate in a loop, and
    // must not make an unrelated write fail. Skip it.
    if (target.kind === 'invalid') continue;

    const key = foldPathKey(fromPath);
    // First writer wins, so the walk is deterministic even if the unique
    // index was bypassed by a casing difference.
    if (edges.has(key)) continue;

    edges.set(key, {
      fromPath,
      toPath: target.kind === 'internal' ? target.path : null,
      note: target.kind === 'internal' ? target.path : target.raw,
    });
  }

  return edges;
}

export type ChainProblem = { kind: 'loop' | 'too-long'; path: string[] };

/**
 * Walk the chain starting at `startKey`, bounded twice over: a visited set
 * (catches any loop, however long) and a hop budget (catches a chain that is
 * finite but deeper than the frontend resolver will follow). Returns null when
 * the chain terminates on a real page or an external URL.
 */
export function walkChain(
  edges: Map<string, Edge>,
  startKey: string,
  maxHops: number = REDIRECT_MAX_HOPS,
): ChainProblem | null {
  const start = edges.get(startKey);
  if (!start) return null;

  const visited = new Set<string>([startKey]);
  const display = [start.fromPath];

  let current = start.toPath;
  let hops = 1;

  while (current !== null) {
    const key = foldPathKey(current);
    display.push(current);

    if (visited.has(key)) return { kind: 'loop', path: display };
    visited.add(key);

    if (hops > maxHops) return { kind: 'too-long', path: display };

    const next = edges.get(key);
    if (!next) return null; // lands on a real page — the chain terminates

    current = next.toPath;
    hops += 1;
  }

  return null; // ended on an external URL
}

/**
 * Another ACTIVE redirect already claiming the same folded `from`.
 * The column is `unique`, but Postgres uniqueness is byte-exact, so
 * `/Winter-Sale` and `/winter-sale` both save and one silently wins.
 */
export function findDuplicateFrom(edges: Map<string, Edge>, fromKey: string): Edge | null {
  return edges.get(fromKey) ?? null;
}
