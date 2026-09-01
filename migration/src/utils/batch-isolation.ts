export function isRecordSpecificPostgresError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  return code.startsWith("22") || code.startsWith("23") || code === "P0001";
}

/**
 * Bisect only atomic data/constraint failures until the corrupt source row is
 * identified. Infrastructure and schema failures remain fatal for the whole
 * batch instead of being retried once per record.
 */
export async function persistBatchWithIsolation<T, R>(input: {
  batch: readonly T[];
  persist: (batch: readonly T[]) => Promise<R[]>;
  onRecordFailure: (record: T, error: unknown) => void;
}): Promise<R[]> {
  try {
    return await input.persist(input.batch);
  } catch (error) {
    if (!isRecordSpecificPostgresError(error)) throw error;
    if (input.batch.length === 1) {
      input.onRecordFailure(input.batch[0], error);
      return [];
    }
    const middle = Math.ceil(input.batch.length / 2);
    const left = await persistBatchWithIsolation({
      ...input,
      batch: input.batch.slice(0, middle),
    });
    const right = await persistBatchWithIsolation({
      ...input,
      batch: input.batch.slice(middle),
    });
    return [...left, ...right];
  }
}
