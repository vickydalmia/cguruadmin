export type RelationCandidate = {
  id: number;
  documentId: string;
  name: string;
};

export type RelationCommand = RelationCandidate & {
  apiData: {
    id: number;
    documentId: string;
    locale: string | null;
    isTemporary?: boolean;
    position?:
      | { before: string; status: 'published'; locale: null }
      | { end: true };
  };
};

export type RelationFormValue = {
  connect?: RelationCommand[];
  disconnect?: RelationCommand[];
};

export const isRelationFormValue = (
  value: unknown,
): value is RelationFormValue =>
  Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ('connect' in value || 'disconnect' in value),
  );

export const getRelationDocumentId = (
  relation: unknown,
): string | undefined => {
  if (!relation || typeof relation !== 'object') return undefined;
  const value = relation as {
    documentId?: unknown;
    apiData?: { documentId?: unknown };
  };
  const documentId = value.apiData?.documentId ?? value.documentId;
  return typeof documentId === 'string' ? documentId : undefined;
};

export const toRelationCommand = (
  candidate: RelationCandidate,
  options: {
    isTemporary?: boolean;
    position?:
      | { before: string; status: 'published'; locale: null }
      | { end: true };
  } = {},
): RelationCommand => ({
  id: candidate.id,
  documentId: candidate.documentId,
  name: candidate.name,
  apiData: {
    id: candidate.id,
    documentId: candidate.documentId,
    locale: null,
    ...(options.isTemporary ? { isTemporary: true } : {}),
    ...(options.position ? { position: options.position } : {}),
  },
});

type SingleRelationChange =
  | { type: 'select'; candidate: RelationCandidate }
  | { type: 'remove'; candidate: RelationCandidate };

type SingleRelationChangeInput = {
  change: SingleRelationChange;
  selected: readonly RelationCandidate[];
  persistedDocumentIds: ReadonlySet<string>;
  formValue?: RelationFormValue;
  minSelections?: number;
};

export type SingleRelationChangeResult = {
  selected: RelationCandidate[];
  formValue: RelationFormValue;
};

const candidateFromCommand = (
  command: RelationCommand,
): RelationCandidate | null => {
  const documentId = getRelationDocumentId(command);
  if (!documentId) return null;
  return {
    id: command.id,
    documentId,
    name: command.name ?? String(command.id),
  };
};

/**
 * Builds the complete relation diff for a single-choice relation.
 *
 * The database relation remains many-to-many, so replacing a Store is still a
 * connect/disconnect patch. Rebuilding both arrays from the desired final
 * selection makes replacement atomic and also cancels stale pending commands
 * (including re-selecting a Store that was pending disconnect).
 *
 * Returns null when a removal would go below `minSelections`. Rebuilding from
 * an empty final selection is valid when the relation is optional and emits a
 * disconnect for every persisted Store.
 */
export function singleRelationChange({
  change,
  selected,
  persistedDocumentIds,
  formValue = {},
  minSelections = 1,
}: SingleRelationChangeInput): SingleRelationChangeResult | null {
  const next =
    change.type === 'select'
      ? [change.candidate]
      : selected.filter(
          (candidate) =>
            candidate.documentId !== change.candidate.documentId,
        );

  if (next.length < minSelections) return null;

  const candidatesByDocumentId = new Map<string, RelationCandidate>();
  for (const candidate of selected) {
    candidatesByDocumentId.set(candidate.documentId, candidate);
  }
  for (const command of [
    ...(formValue.connect ?? []),
    ...(formValue.disconnect ?? []),
  ]) {
    const candidate = candidateFromCommand(command);
    if (candidate) {
      candidatesByDocumentId.set(candidate.documentId, candidate);
    }
  }
  for (const candidate of next) {
    candidatesByDocumentId.set(candidate.documentId, candidate);
  }

  const nextDocumentIds = new Set(
    next.map((candidate) => candidate.documentId),
  );
  const connect = next
    .filter(
      (candidate) => !persistedDocumentIds.has(candidate.documentId),
    )
    .map((candidate) =>
      toRelationCommand(candidate, { isTemporary: true }),
    );
  const disconnect = [...persistedDocumentIds].flatMap((documentId) => {
    if (nextDocumentIds.has(documentId)) return [];
    const candidate = candidatesByDocumentId.get(documentId);
    return candidate ? [toRelationCommand(candidate)] : [];
  });

  return {
    selected: next,
    formValue: { connect, disconnect },
  };
}
