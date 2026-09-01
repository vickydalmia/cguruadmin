/**
 * Run a bounded worker pool. The first failure stops new items from starting,
 * while work that was already active is allowed to settle before the combined
 * error reaches the phase orchestrator.
 */
export async function runBoundedWork<T>(input: {
  items: readonly T[];
  concurrency: number;
  worker: (item: T, index: number) => Promise<void>;
  label: string;
}): Promise<void> {
  const concurrency = Math.max(1, Math.floor(input.concurrency));
  let nextIndex = 0;
  const failures: unknown[] = [];

  const runWorker = async (): Promise<void> => {
    while (failures.length === 0) {
      const index = nextIndex++;
      if (index >= input.items.length) return;
      try {
        await input.worker(input.items[index], index);
      } catch (error) {
        failures.push(error);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, input.items.length) },
      () => runWorker(),
    ),
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${input.label}: ${failures.length} task(s) failed`,
    );
  }
}
