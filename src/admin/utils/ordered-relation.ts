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
