// The IMPORT HOOK for the unique-code panel: file acceptance and parsing,
// pool stats, drag state, and the sequential chunked request loop with
// retry state. Presentation lives in the sibling components; everything
// decidable from the file's text alone lives in ./parse-codes-file and
// friends, under test.
import * as React from 'react';
import { useFetchClient } from '@strapi/strapi/admin';

import { DEFAULT_CHUNK_SIZE, chunkCodes } from './chunk-codes';
import {
  reduceImportCompletion,
  type ChunkImportResult,
  type ImportSummary,
} from './import-completion';
import {
  MAX_IMPORT_FILE_BYTES,
  parseCodesFile,
  uploadBlocker,
  type ParsedCodes,
} from './parse-codes-file';
import { type PoolStats } from './stock-status';

const UPLOAD_PATH = '/unique-coupon/upload';
const STATS_PATH = '/unique-coupon/stats';

export type Progress = { done: number; total: number };

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as any).response?.data?.error?.message;
    if (typeof response === 'string' && response) return response;
    const message = (error as any).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Request failed';
}

export function useCodeImport(documentId: string | undefined) {
  const { get, post } = useFetchClient();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = React.useState<string | null>(null);
  const [parsed, setParsed] = React.useState<ParsedCodes | null>(null);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);
  const [statsBefore, setStatsBefore] = React.useState<PoolStats | null>(null);
  const [statsAfter, setStatsAfter] = React.useState<PoolStats | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  const loadStats = React.useCallback(async (): Promise<PoolStats | null> => {
    if (!documentId) return null;
    try {
      const { data } = await get(`${STATS_PATH}/${documentId}`);
      return data as PoolStats;
    } catch {
      // Stats are informational only — never block an import on them.
      return null;
    }
  }, [documentId, get]);

  React.useEffect(() => {
    let cancelled = false;
    void loadStats().then((stats) => {
      if (!cancelled) setStatsBefore(stats);
    });
    return () => {
      cancelled = true;
    };
  }, [loadStats]);

  // One path for both entry points — the picker and a drop — so the size guard
  // and the parse can never diverge between them.
  const acceptFile = async (file: File | undefined) => {
    setSummary(null);
    setStatsAfter(null);
    setParseError(null);
    setParsed(null);
    setFileName(file?.name ?? null);
    if (!file) return;

    // Refuse an over-sized file BEFORE reading it into memory — file.text() on a
    // multi-hundred-MB or mis-selected file freezes or kills the admin tab.
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
      setParseError(
        `This file is ${mb(file.size)} MB. The import accepts files up to ` +
          `${mb(MAX_IMPORT_FILE_BYTES)} MB — split it or remove any non-code content.`,
      );
      return;
    }

    try {
      setParsed(parseCodesFile(await file.text()));
    } catch (error) {
      setParseError(`Could not read this file: ${errorMessage(error)}`);
    }
  };

  const busy = Boolean(progress);

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (busy) return;
    void acceptFile(event.dataTransfer.files?.[0]);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    // Without preventDefault the browser navigates to the dropped file.
    event.preventDefault();
    if (!busy) setIsDragging(true);
  };

  const clearSelection = () => {
    setParsed(null);
    setFileName(null);
    setParseError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const blocker = parsed ? uploadBlocker(parsed) : null;
  const canUpload = Boolean(documentId && parsed && !blocker && !progress);

  const onUpload = async () => {
    if (!documentId || !parsed || blocker) return;

    const chunks = chunkCodes(parsed.codes, DEFAULT_CHUNK_SIZE, {
      poolDocumentId: documentId,
    });
    const results: ChunkImportResult[] = [];

    setSummary(null);
    setProgress({ done: 0, total: chunks.length });

    // Sequential requests keep progress and retry boundaries predictable.
    // The pool-row lock plus PostgreSQL relation guards provide concurrency
    // safety across requests and direct relation writes.
    for (const [index, chunk] of chunks.entries()) {
      try {
        const { data } = await post(UPLOAD_PATH, {
          poolDocumentId: documentId,
          codes: chunk,
        });
        results.push({
          count: chunk.length,
          codes: chunk,
          imported: typeof data?.imported === 'number' ? data.imported : 0,
          skipped: typeof data?.skipped === 'number' ? data.skipped : 0,
        });
      } catch (error) {
        results.push({
          count: chunk.length,
          codes: chunk,
          error: `Batch ${index + 1} of ${chunks.length}: ${errorMessage(error)}`,
        });
      }
      setProgress({ done: index + 1, total: chunks.length });
    }

    const completion = reduceImportCompletion(parsed, fileName, results);
    setSummary(completion.summary);
    setParsed(completion.parsed);
    setFileName(completion.fileName);
    setProgress(null);
    setStatsAfter(await loadStats());
    if (inputRef.current) inputRef.current.value = '';
  };

  return {
    inputRef,
    fileName,
    parsed,
    parseError,
    setParseError,
    progress,
    summary,
    setSummary,
    statsBefore,
    statsAfter,
    isDragging,
    setIsDragging,
    busy,
    blocker,
    canUpload,
    acceptFile,
    clearSelection,
    onDrop,
    onDragOver,
    onUpload,
  };
}
