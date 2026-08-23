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
 *
 * PRESENTATION. Everything visible is a Strapi design-system primitive, so the
 * panel inherits the admin's theme, spacing scale and dark mode instead of the
 * bare `<input type="file">` this started as. The file input is still the real
 * control — it is visually hidden and taken out of the tab order, with a DS
 * Button as the single focusable way in, so the panel gains a drop zone without
 * gaining a second invisible tab stop that does the same thing.
 *
 * The sample CSV is generated in the browser from SAMPLE_CODES_CSV rather than
 * shipped as a static asset: the admin build has no public asset pipeline of
 * its own, and the parser's own test pins that constant, so the file an editor
 * downloads cannot drift from the importer that has to read it back.
 */

import * as React from 'react';
import { useFetchClient } from '@strapi/strapi/admin';
import {
  Alert,
  Box,
  Button,
  Field,
  Flex,
  ProgressBar,
  TextButton,
  Typography,
  VisuallyHidden,
} from '@strapi/design-system';
import { CloudUpload, Download, FileCsv } from '@strapi/icons';

import {
  DEFAULT_CHUNK_SIZE,
  MAX_IMPORT_FILE_BYTES,
  SAMPLE_CODES_CSV,
  SAMPLE_CODES_FILE_NAME,
  chunkCodes,
  parseCodesFile,
  reduceImportCompletion,
  uploadBlocker,
  type ChunkImportResult,
  type ImportSummary,
  type ParsedCodes,
} from '../utils/parse-codes';
import { downloadBlob } from '../utils/download-blob';

const UPLOAD_PATH = '/unique-coupon/upload';
const STATS_PATH = '/unique-coupon/stats';

/**
 * Warn while there is still time to act. An empty pool now EXPIRES every
 * coupon that draws from it (the scheduler flips contentStatus within five
 * minutes), so running dry silently takes offers off the site.
 */
const LOW_STOCK_THRESHOLD = 50;

type PoolStats = {
  totalCodes: number;
  usedCodes: number;
  availableCodes: number;
};

type StockTone = {
  text: string;
  background: string;
  border: string;
  note: string | null;
};

/**
 * An empty pool now EXPIRES every offer drawing from it, so stock is a status,
 * not a footnote — it gets design-system colour rather than grey body text.
 */
function stockTone(stats: PoolStats): StockTone {
  if (stats.availableCodes === 0) {
    return {
      text: 'danger600',
      background: 'danger100',
      border: 'danger200',
      note: 'This pool is empty — every offer using it stays expired until you import more codes.',
    };
  }
  if (stats.availableCodes <= LOW_STOCK_THRESHOLD) {
    return {
      text: 'warning600',
      background: 'warning100',
      border: 'warning200',
      note: 'Running low — import more before it empties.',
    };
  }
  return {
    text: 'neutral700',
    background: 'neutral100',
    border: 'neutral200',
    note: null,
  };
}

/**
 * Hand the editor a template they can fill in and upload straight back.
 *
 * Built from the constant the parser's own test pins, so the file an editor
 * downloads is guaranteed to survive the importer. Generated in the browser
 * rather than served as a static asset: the admin build has no public asset
 * pipeline of its own, and a few hundred bytes of CSV is not worth one.
 */
function downloadSampleCsv() {
  // BOM so Excel opens the file as UTF-8 instead of mangling it.
  const blob = new Blob([`\ufeff${SAMPLE_CODES_CSV}`], {
    type: 'text/csv;charset=utf-8',
  });
  downloadBlob(SAMPLE_CODES_FILE_NAME, blob);
}

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

  if (!documentId) {
    return (
      <Typography variant="pi" textColor="neutral600">
        Save this pool first — codes attach to a saved pool.
      </Typography>
    );
  }

  const tone = statsBefore ? stockTone(statsBefore) : null;
  const dropBorder = isDragging ? 'primary600' : 'neutral200';
  const dropBackground = isDragging ? 'primary100' : 'neutral0';

  return (
    <Flex direction="column" alignItems="stretch" gap={4} width="100%">
      {statsBefore && tone ? (
        <Box
          padding={3}
          hasRadius
          background={tone.background}
          borderColor={tone.border}
        >
          <Flex direction="column" alignItems="start" gap={1}>
            <Typography variant="pi" fontWeight="bold" textColor={tone.text}>
              {statsBefore.availableCodes.toLocaleString()} unused of{' '}
              {statsBefore.totalCodes.toLocaleString()}
            </Typography>
            {tone.note ? (
              <Typography variant="pi" textColor={tone.text}>
                {tone.note}
              </Typography>
            ) : null}
          </Flex>
        </Box>
      ) : null}

      <Field.Root name="unique-code-import-file">
        <Field.Label>Code file</Field.Label>
        <Box
          padding={5}
          hasRadius
          borderStyle="dashed"
          borderWidth="1px"
          borderColor={dropBorder}
          background={dropBackground}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={() => setIsDragging(false)}
        >
          <Flex direction="column" alignItems="center" gap={2}>
            <CloudUpload
              width="2rem"
              height="2rem"
              fill={isDragging ? 'primary600' : 'neutral500'}
              aria-hidden
            />
            <Typography variant="pi" textColor="neutral600" textAlign="center">
              Drag a .csv or .txt file here, or
            </Typography>
            <Button
              variant="secondary"
              size="S"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              Browse files
            </Button>
            <Typography variant="pi" textColor="neutral500" textAlign="center">
              One code per line. Extra columns are ignored and a
              &ldquo;code&rdquo; header row is skipped.
            </Typography>
          </Flex>

          {/*
            The Button above is the single focusable control, so the input is
            taken out of the tab order — otherwise the panel has an invisible
            second tab stop that does the same thing.
          */}
          <VisuallyHidden>
            <input
              ref={inputRef}
              type="file"
              tabIndex={-1}
              accept=".txt,.csv,text/plain,text/csv"
              onChange={(event) => void acceptFile(event.target.files?.[0])}
              disabled={busy}
            />
          </VisuallyHidden>
        </Box>
      </Field.Root>

      <Flex justifyContent="space-between" alignItems="center" gap={2}>
        <TextButton startIcon={<Download />} onClick={downloadSampleCsv}>
          Download sample CSV
        </TextButton>
        <Typography variant="pi" textColor="neutral500">
          Re-uploading is safe
        </Typography>
      </Flex>

      {parseError ? (
        <Alert
          variant="danger"
          title="Could not read that file"
          closeLabel="Dismiss"
          onClose={() => setParseError(null)}
        >
          {parseError}
        </Alert>
      ) : null}

      {parsed ? (
        <Box padding={3} hasRadius background="neutral100" borderColor="neutral200">
          <Flex justifyContent="space-between" alignItems="center" gap={2}>
            <Flex alignItems="center" gap={2} minWidth={0}>
              <FileCsv width="1.5rem" height="1.5rem" fill="neutral500" aria-hidden />
              <Flex direction="column" alignItems="start">
                <Typography variant="pi" fontWeight="bold" textColor="neutral800">
                  {fileName}
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  {parsed.codes.length.toLocaleString()} code
                  {parsed.codes.length === 1 ? '' : 's'} ready
                  {parsed.duplicates > 0
                    ? ` · ${parsed.duplicates.toLocaleString()} duplicate${parsed.duplicates === 1 ? '' : 's'} in file`
                    : ''}
                  {parsed.invalid.length > 0
                    ? ` · ${parsed.invalid.length.toLocaleString()} unusable`
                    : ''}
                </Typography>
                {parsed.invalid.length > 0 ? (
                  <Typography variant="pi" textColor="danger600">
                    First problem on line {parsed.invalid[0]!.line} (
                    {parsed.invalid[0]!.reason === 'too-long'
                      ? 'longer than 255 characters'
                      : 'contains control characters'}
                    ).
                  </Typography>
                ) : null}
              </Flex>
            </Flex>
            {busy ? null : (
              <TextButton onClick={clearSelection}>Remove</TextButton>
            )}
          </Flex>
        </Box>
      ) : null}

      {blocker ? (
        <Typography variant="pi" textColor="danger600">
          {blocker}
        </Typography>
      ) : null}

      {progress ? (
        <Flex direction="column" alignItems="stretch" gap={2}>
          <ProgressBar
            value={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
          />
          <Typography variant="pi" textColor="neutral600">
            Uploading batch {progress.done} of {progress.total}…
          </Typography>
        </Flex>
      ) : null}

      <Button
        startIcon={<CloudUpload />}
        onClick={onUpload}
        disabled={!canUpload}
        loading={busy}
        fullWidth
      >
        {summary?.failed && parsed ? 'Retry failed batches' : 'Import codes'}
      </Button>

      {summary ? (
        <Alert
          variant={summary.failed > 0 ? 'warning' : 'success'}
          title={summary.failed > 0 ? 'Import finished with errors' : 'Import complete'}
          closeLabel="Dismiss"
          onClose={() => setSummary(null)}
        >
          <Flex direction="column" alignItems="start" gap={1}>
            <Typography variant="pi">
              Imported {summary.imported.toLocaleString()} · skipped{' '}
              {summary.skipped.toLocaleString()} · failed{' '}
              {summary.failed.toLocaleString()}.
              {statsAfter
                ? ` Pool now holds ${statsAfter.totalCodes.toLocaleString()} codes.`
                : ''}
            </Typography>
            {summary.errors.map((message) => (
              <Typography key={message} variant="pi" textColor="danger600">
                {message}
              </Typography>
            ))}
          </Flex>
        </Alert>
      ) : null}
    </Flex>
  );
};

export default React.memo(UniqueCodeImport);
