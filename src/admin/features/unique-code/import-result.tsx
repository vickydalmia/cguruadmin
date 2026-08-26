// RESULT presentation for the unique-code import: the summary alert with
// per-batch errors and the post-import pool size. State comes from
// ./use-code-import.
import * as React from 'react';
import { Alert, Flex, Typography } from '@strapi/design-system';

import { type ImportSummary } from './import-completion';
import { type PoolStats } from './stock-status';

export function ImportResult({
  summary,
  statsAfter,
  onDismiss,
}: {
  summary: ImportSummary;
  statsAfter: PoolStats | null;
  onDismiss: () => void;
}) {
  return (
    <Alert
      variant={summary.failed > 0 ? 'warning' : 'success'}
      title={summary.failed > 0 ? 'Import finished with errors' : 'Import complete'}
      closeLabel="Dismiss"
      onClose={onDismiss}
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
  );
}
