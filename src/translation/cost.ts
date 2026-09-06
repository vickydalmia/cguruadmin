// Translation COST ACCOUNTING: pure math shared by the dispatcher's
// per-job bookkeeping and the backfill dry-run estimate. The daily-budget
// SUM itself lives with the outbox store (it is a table query).
import type { TranslationConfig } from './config';

export function usdForTokens(
  config: Pick<TranslationConfig, 'inputCostPerMTok' | 'outputCostPerMTok'>,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * config.inputCostPerMTok +
    (outputTokens / 1_000_000) * config.outputCostPerMTok
  );
}

/**
 * Dry-run heuristic. English source: ~4 chars/token. Input carries the
 * prompt scaffolding once per chunk plus the source text (JSON overhead
 * ~1.3×). Arabic output of the same meaning runs ~1.15× the source chars at
 * a denser ~2.5 chars/token. Rough by design — the estimate exists to catch
 * order-of-magnitude surprises before a backfill, not to invoice.
 */
export type CostEstimate = {
  entries: number;
  translatableChars: number;
  estimatedCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedUsd: number;
};

export function estimateBackfillCost(
  config: Pick<
    TranslationConfig,
    'inputCostPerMTok' | 'outputCostPerMTok' | 'chunkChars'
  >,
  perEntryChars: readonly number[],
  promptOverheadChars: number,
  passesPerChunk = 1,
): CostEstimate {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalChars = 0;
  for (const chars of perEntryChars) {
    if (chars <= 0) continue;
    totalChars += chars;
    const chunks = Math.max(1, Math.ceil(chars / config.chunkChars));
    calls += chunks * passesPerChunk;
    inputTokens += Math.round(
      ((chars * 1.3 + chunks * promptOverheadChars) * passesPerChunk) / 4,
    );
    outputTokens += Math.round(((chars * 1.15) / 2.5) * passesPerChunk);
  }
  return {
    entries: perEntryChars.length,
    translatableChars: totalChars,
    estimatedCalls: calls,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedUsd:
      Math.round(usdForTokens(config, inputTokens, outputTokens) * 100) / 100,
  };
}
