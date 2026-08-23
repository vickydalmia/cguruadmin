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
 * the file's text alone lives in ./parse-codes-file (with chunking in
 * ./chunk-codes and completion reduction in ./import-completion), under
 * test. File reading and the chunked request loop live in
 * ./use-code-import; this file only composes the presentation modules.
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
import {
  Alert,
  Box,
  Button,
  Flex,
  TextButton,
  Typography,
} from '@strapi/design-system';
import { CloudUpload, Download, FileCsv } from '@strapi/icons';

import { downloadBlob } from '../../utils/download-blob';
import { CodeDropZone } from './code-drop-zone';
import { ImportProgress } from './import-progress';
import { ImportResult } from './import-result';
import { SAMPLE_CODES_CSV, SAMPLE_CODES_FILE_NAME } from './sample-codes';
import { StockStatusBanner } from './stock-status';
import { useCodeImport } from './use-code-import';

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

const UniqueCodeImport = ({ documentId }: { documentId?: string }) => {
  const {
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
  } = useCodeImport(documentId);

  if (!documentId) {
    return (
      <Typography variant="pi" textColor="neutral600">
        Save this pool first — codes attach to a saved pool.
      </Typography>
    );
  }

  return (
    <Flex direction="column" alignItems="stretch" gap={4} width="100%">
      {statsBefore ? <StockStatusBanner stats={statsBefore} /> : null}

      <CodeDropZone
        inputRef={inputRef}
        busy={busy}
        isDragging={isDragging}
        setIsDragging={setIsDragging}
        acceptFile={acceptFile}
        onDrop={onDrop}
        onDragOver={onDragOver}
      />

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

      {progress ? <ImportProgress progress={progress} /> : null}

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
        <ImportResult
          summary={summary}
          statsAfter={statsAfter}
          onDismiss={() => setSummary(null)}
        />
      ) : null}
    </Flex>
  );
};

export default React.memo(UniqueCodeImport);
