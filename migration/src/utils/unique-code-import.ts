export type PreparedUniqueCode = {
  wpId: number;
  targetPoolId: number | null;
  documentId: string;
  code: string;
  isUsed: boolean;
  version: number;
};

export function collapseBatchDuplicateCodes(
  candidates: PreparedUniqueCode[],
): { rows: PreparedUniqueCode[]; removed: number } {
  const retained = new Map<string, PreparedUniqueCode>();

  for (const candidate of candidates) {
    // Codes without a resolved pool do not participate in the per-pool
    // uniqueness contract, so retain their WordPress identity independently.
    const key =
      candidate.targetPoolId === null
        ? `unlinked:${candidate.wpId}`
        : JSON.stringify([candidate.targetPoolId, candidate.code]);
    const current = retained.get(key);
    if (!current) {
      retained.set(key, { ...candidate });
      continue;
    }

    // The first candidate is the lowest WordPress id because Phase 6 reads in
    // ascending keyset order. Keep that document identity stable regardless of
    // which duplicate becomes redeemed, while conservatively merging state.
    current.isUsed = current.isUsed || candidate.isUsed;
    current.version = Math.max(current.version, candidate.version);
  }

  return {
    rows: [...retained.values()],
    removed: candidates.length - retained.size,
  };
}
