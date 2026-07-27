export type OrderedRelationCandidate = {
  id: number;
  documentId: string;
  name: string;
};

export type OrderedRelationCommand<T extends OrderedRelationCandidate> = T & {
  apiData: {
    id: number;
    documentId: string;
    locale: null;
    position:
      | { before: string; status: 'published'; locale: null }
      | { end: true };
  };
};

/**
 * Content Manager returns ordered relations newest-position first. Its native
 * relation input reverses each page and prepends later pages to reconstruct the
 * persisted editorial order. Custom relation panels must do the same or an
 * innocuous reopen-and-save reverses the selection.
 */
export function mergeDescendingRelationPage<T>(
  current: readonly T[],
  descendingPage: readonly T[],
): T[] {
  return [...descendingPage].reverse().concat(current);
}

/**
 * Strapi persists relation order through positional connect commands. The
 * tail is connected first, then every preceding item is inserted before its
 * successor.
 *
 * Always build this from the complete final selection. Reusing commands from
 * an earlier order can leave a `before` reference pointing at a removed item.
 */
export function orderedRelationCommands<T extends OrderedRelationCandidate>(
  selected: readonly T[],
): Array<OrderedRelationCommand<T>> {
  return selected
    .map((candidate, index) => ({
      ...candidate,
      apiData: {
        id: candidate.id,
        documentId: candidate.documentId,
        locale: null,
        position: selected[index + 1]
          ? {
              before: selected[index + 1].documentId,
              status: 'published' as const,
              locale: null,
            }
          : { end: true as const },
      },
    }))
    .reverse();
}

/**
 * Reorder commands reconnect every selected item, including relations that
 * already exist in the database. Use the original persisted-ID snapshot—not
 * the current connect array—to decide whether removal also needs a disconnect.
 */
export function removalNeedsDisconnect(
  persistedDocumentIds: ReadonlySet<string> | null,
  documentId: string,
  hasExplicitTemporaryConnect: boolean,
): boolean {
  return persistedDocumentIds?.has(documentId) ?? !hasExplicitTemporaryConnect;
}
