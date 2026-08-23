// Completion REDUCTION for the bulk unique-code import: fold per-chunk
// results into the summary the UI shows and the retry state for failed
// batches. File parsing lives in ./parse-codes-file.
import { type ParsedCodes } from './parse-codes-file';

export type ImportSummary = {
  /** Rows the server reported inserting. */
  imported: number;
  /** Dropped before upload: in-file duplicates + unusable values. */
  skipped: number;
  /** Codes in chunks whose request failed. */
  failed: number;
  /** One message per failed chunk, for the error list. */
  errors: string[];
};

export type ChunkImportResult = {
  count: number;
  /** Exact codes in this request, retained only when its request fails. */
  codes?: readonly string[];
  imported?: number;
  /** Existing rows the server ignored safely. */
  skipped?: number;
  error?: string;
};

/**
 * Fold per-chunk results into the imported / skipped / failed the UI shows.
 * Pure so the arithmetic is testable without mocking a network.
 */
export function summariseImport(
  parsed: ParsedCodes,
  chunkResults: readonly ChunkImportResult[],
): ImportSummary {
  let imported = 0;
  let serverSkipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const result of chunkResults) {
    if (result.error) {
      failed += result.count;
      errors.push(result.error);
      continue;
    }
    imported += result.imported ?? 0;
    serverSkipped += result.skipped ?? 0;
  }

  return {
    imported,
    skipped: parsed.duplicates + parsed.invalid.length + serverSkipped,
    failed,
    errors,
  };
}

export type ImportCompletion = {
  summary: ImportSummary;
  /** Only failed HTTP batches remain uploadable; null means the import ended. */
  parsed: ParsedCodes | null;
  fileName: string | null;
};

/**
 * Reduce one completed request loop into the next UI state. Successful chunks
 * are removed permanently; failed chunks remain available for a one-click
 * retry without resubmitting stock that the server already accepted.
 */
export function reduceImportCompletion(
  parsed: ParsedCodes,
  fileName: string | null,
  chunkResults: readonly ChunkImportResult[],
): ImportCompletion {
  const retryCodes = chunkResults.flatMap((result) =>
    result.error ? [...(result.codes ?? [])] : [],
  );

  return {
    summary: summariseImport(parsed, chunkResults),
    parsed: retryCodes.length > 0
      ? {
          codes: retryCodes,
          total: retryCodes.length,
          duplicates: 0,
          invalid: [],
          headerSkipped: false,
        }
      : null,
    fileName: retryCodes.length > 0 ? fileName : null,
  };
}
