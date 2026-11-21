import * as React from 'react';
import { Badge, Box, Button, Flex, Typography } from '@strapi/design-system';
import { Download } from '@strapi/icons';
import type { AdsCampaignRun } from '../../../../constants/ads-generator';
import { downloadAllCsv, downloadCsv } from '../api';
import { AdsResult } from './ads-result';

const STATUS_LABEL: Record<AdsCampaignRun['status'], string> = {
  queued: 'Queued',
  running: 'Generating',
  succeeded: 'Ready',
  failed: 'Failed',
};

/** Every campaign's outcome, with the ZIP download and a retry for failures. */
export function AdsBatchResult({ runs, busy, onRetry }: { runs: AdsCampaignRun[]; busy: boolean; onRetry: () => void }) {
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const ready = runs.filter((run) => run.status === 'succeeded');
  const failed = runs.filter((run) => run.status === 'failed');

  return (
    <Flex direction="column" alignItems="stretch" gap={4}>
      <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
        <Typography variant="beta" tag="h2">{ready.length} of {runs.length} ready</Typography>
        <Flex gap={2} wrap="wrap">
          {failed.length > 0 && !busy && (
            <Button variant="secondary" onClick={onRetry}>Retry failed ({failed.length})</Button>
          )}
          {runs.length > 1 && (
            <Button startIcon={<Download />} disabled={!ready.length} onClick={() => downloadAllCsv(ready)}>
              Download all ({ready.length} CSV, ZIP)
            </Button>
          )}
        </Flex>
      </Flex>
      {runs.map((run) => (
        <Box key={run.key} borderColor="neutral200" hasRadius padding={4}>
          <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
            <Flex gap={2} wrap="wrap">
              <Typography fontWeight="bold">{run.index + 1}. {run.campaignName}</Typography>
              <Badge>{STATUS_LABEL[run.status]}</Badge>
            </Flex>
            {run.result && (
              <Flex gap={2}>
                <Button variant="tertiary" size="S" aria-expanded={openKey === run.key} onClick={() => setOpenKey(openKey === run.key ? null : run.key)}>
                  {openKey === run.key ? 'Hide ads' : 'Review ads'}
                </Button>
                <Button size="S" startIcon={<Download />} onClick={() => downloadCsv(run.result!.csv)}>
                  CSV ({run.result.csv.rows} rows)
                </Button>
              </Flex>
            )}
          </Flex>
          {run.error && (
            <Box role="alert" paddingTop={2}>
              <Typography textColor="danger700">{run.error.message}</Typography>
              {run.error.problems.length > 0 && (
                <ul>{run.error.problems.map((problem) => <li key={problem}><Typography textColor="danger700">• {problem}</Typography></li>)}</ul>
              )}
            </Box>
          )}
          {run.result && openKey === run.key && <Box paddingTop={4}><AdsResult result={run.result} /></Box>}
        </Box>
      ))}
    </Flex>
  );
}
