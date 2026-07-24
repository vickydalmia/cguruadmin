/**
 * Bulk unique-code import affordance for the Unique Coupon Pool edit view.
 * Row 83.
 *
 * The server side already exists and is NOT re-implemented here:
 *   POST /unique-coupon/upload           { poolDocumentId, codes }
 *   GET  /unique-coupon/stats/:documentId
 * both behind `admin::isAuthenticatedAdmin` plus the
 * `plugin::unique-coupon.codes.import` RBAC action
 * (src/plugins/unique-coupon/server/src/routes/index.ts) — the side panel in
 * app.tsx checks the same action and never mounts this component without it.
 * Plugin routes are mounted at the root, NOT under /api — the ISR gateway
 * proxies the sibling redeem route to exactly `/unique-coupon/redeem`, which
 * pins the prefix.
 *
 * This component is deliberately thin: every decision that can be made from
 * the file's text alone lives in ../utils/parse-codes.ts, under test. What is
 * left here is file reading, the chunked request loop, and rendering.
 *
 * WHY CHUNKED. Strapi's koa body parser caps a JSON body at 1 MB by default,
 * so a 20,000-code file posted in one request is rejected wholesale with a
 * 413 and the editor sees nothing useful. Codes go up in batches of
 * DEFAULT_CHUNK_SIZE (2,000) instead — worst case ~514 KB per request.
 *
 * Re-upload is idempotent per pool: the service ignores rows already protected
 * by the database's pool/code relation guards. If an HTTP batch fails, the
 * reducer keeps exactly that batch available for retry and clears every batch
 * the server accepted.
 */

import * as React from 'react';
import { useFetchClient } from '@strapi/strapi/admin';
import {
  Box,
  Button,
  Field,
  Flex,
  Loader,
  Typography,
} from '@strapi/design-system';

import {
  DEFAULT_CHUNK_SIZE,
  MAX_IMPORT_FILE_BYTES,
  chunkCodes,
  parseCodesFile,
  reduceImportCompletion,
  uploadBlocker,
  type ChunkImportResult,
  type ImportSummary,
  type ParsedCodes,
} from '../utils/parse-codes';

const UPLOAD_PATH = '/unique-coupon/upload';
const STATS_PATH = '/unique-coupon/stats';

type PoolStats = {
  totalCodes: number;
  usedCodes: number;
  availableCodes: number;
};

type Progress = { done: number; total: number };

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as any).response?.data?.error?.message;
    if (typeof response === 'string' && response) return response;
    const message = (error as any).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Request failed';
}

const UniqueCodeImport = ({ documentId }: { documentId?: string }) => {
  const { get, post } = useFetchClient();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = React.useState<string | null>(null);
  const [parsed, setParsed] = React.useState<ParsedCodes | null>(null);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);
  const [statsBefore, setStatsBefore] = React.useState<PoolStats | null>(null);
  const [statsAfter, setStatsAfter] = React.useState<PoolStats | null>(null);

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

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
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

  if (!documentId) {
    return (
      <Typography variant="pi" textColor="neutral600">
        Save this pool first — codes attach to a saved pool.
      </Typography>
    );
  }

  return (
    <Flex direction="column" alignItems="stretch" gap={3} width="100%">
      <Typography variant="pi" textColor="neutral600">
        One code per line (.txt or .csv). Extra columns are ignored; a
        &ldquo;code&rdquo; header row is skipped automatically.
      </Typography>

      {statsBefore ? (
        <Typography variant="pi" textColor="neutral600">
          Pool now holds {statsBefore.totalCodes.toLocaleString()} codes (
          {statsBefore.availableCodes.toLocaleString()} unused).
        </Typography>
      ) : null}

      <Field.Root name="unique-code-import-file">
        <Field.Label>Code file</Field.Label>
        <input
          ref={inputRef}
          type="file"
          accept=".txt,.csv,text/plain,text/csv"
          onChange={onFileChange}
          disabled={Boolean(progress)}
        />
      </Field.Root>

      {parseError ? (
        <Typography variant="pi" textColor="danger600">
          {parseError}
        </Typography>
      ) : null}

      {parsed ? (
        <Box>
          <Typography variant="pi" textColor="neutral700">
            {fileName}: {parsed.codes.length.toLocaleString()} code
            {parsed.codes.length === 1 ? '' : 's'} ready
            {parsed.duplicates > 0
              ? `, ${parsed.duplicates.toLocaleString()} duplicate${parsed.duplicates === 1 ? '' : 's'} in file`
              : ''}
            {parsed.invalid.length > 0
              ? `, ${parsed.invalid.length.toLocaleString()} unusable`
              : ''}
            .
          </Typography>
          {parsed.invalid.length > 0 ? (
            <Typography variant="pi" textColor="danger600">
              {' '}
              First problem on line {parsed.invalid[0]!.line} (
              {parsed.invalid[0]!.reason === 'too-long'
                ? 'longer than 255 characters'
                : 'contains control characters'}
              ).
            </Typography>
          ) : null}
        </Box>
      ) : null}

      {blocker ? (
        <Typography variant="pi" textColor="danger600">
          {blocker}
        </Typography>
      ) : null}

      <Typography variant="pi" textColor="warning600">
        Codes already present in this pool are skipped safely.
      </Typography>

      <Button onClick={onUpload} disabled={!canUpload} loading={Boolean(progress)}>
        {progress
          ? `Uploading batch ${progress.done} of ${progress.total}…`
          : summary?.failed && parsed
            ? 'Retry failed batches'
            : 'Import codes'}
      </Button>

      {progress ? <Loader small>Uploading</Loader> : null}

      {summary ? (
        <Box>
          <Typography variant="pi" textColor="neutral700">
            Imported {summary.imported.toLocaleString()} · skipped{' '}
            {summary.skipped.toLocaleString()} · failed{' '}
            {summary.failed.toLocaleString()}.
          </Typography>
          {statsAfter ? (
            <Typography variant="pi" textColor="neutral600">
              {' '}
              Pool now holds {statsAfter.totalCodes.toLocaleString()} codes.
            </Typography>
          ) : null}
          {summary.errors.map((message) => (
            <Typography key={message} variant="pi" textColor="danger600">
              {message}
            </Typography>
          ))}
        </Box>
      ) : null}
    </Flex>
  );
};

export default React.memo(UniqueCodeImport);
