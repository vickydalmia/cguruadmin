import * as React from 'react';
import { Badge, Box, Button, Flex, Typography } from '@strapi/design-system';
import { Download } from '@strapi/icons';
import type { AdsCampaignRun } from '../../../../constants/ads-generator';
import { downloadAllCsv, downloadAllLabel, downloadableCsv, downloadCsv, downloadId, readDownloaded, rememberDownloaded, remainingDownloads } from '../api';
import { AdsResult } from './ads-result';

const STATUS_LABEL: Record<AdsCampaignRun['status'], string> = {
  queued: 'Queued',
  running: 'Generating',
  succeeded: 'Ready',
  failed: 'Failed',
};

/** Every campaign's outcome, with the combined CSV download and a retry for failures. */
export function AdsBatchResult({ runs, busy, languageChanged, onRetry }: {
  runs: AdsCampaignRun[];
  busy: boolean;
  /** The Arabic checkbox no longer matches this run, so a retry would use the wrong language. */
  languageChanged: boolean;
  onRetry: () => void;
}) {
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const ready = runs.filter((run) => run.status === 'succeeded');
  const failed = runs.filter((run) => run.status === 'failed');
  const [downloaded, setDownloaded] = React.useState(readDownloaded);
  const remaining = remainingDownloads(ready, downloaded);
  const downloadCombined = () => {
    const target = remaining.length ? remaining : ready;
    downloadAllCsv(target);
    setDownloaded((current) => rememberDownloaded(target, current));
  };
  const downloadOne = (run: AdsCampaignRun) => {
    downloadCsv(downloadableCsv(run.result!));
    setDownloaded((current) => rememberDownloaded([run], current));
  };

  return (
    <Flex direction="column" alignItems="stretch" gap={4}>
      <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
        <Typography variant="beta" tag="h2">{ready.length} of {runs.length} ready</Typography>
        <Flex gap={2} wrap="wrap">
          {failed.length > 0 && !busy && (
            <Button variant="secondary" disabled={languageChanged} onClick={onRetry}>Retry failed ({failed.length})</Button>
          )}
          {runs.length > 1 && (
            <Button startIcon={<Download />} disabled={!ready.length} onClick={downloadCombined}>
              {downloadAllLabel(runs.length, ready.length, remaining.length)}
            </Button>
          )}
        </Flex>
      </Flex>
      {languageChanged && (
        <Typography textColor="warning600">
          The language changed since this run. Press Generate to create these campaigns in the selected language.
        </Typography>
      )}
      {runs.length > 1 && ready.length > 0 && failed.length > 0 && (
        <Typography textColor="warning600">
          The CSV has only ready campaigns. After a retry, the next download includes only campaigns you have not downloaded yet.
        </Typography>
      )}
      {runs.map((run) => (
        <Box key={run.key} borderColor="neutral200" hasRadius padding={4}>
          <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
            <Flex gap={2} wrap="wrap">
              <Typography fontWeight="bold">{run.index + 1}. {run.campaignName}</Typography>
              <Badge>{run.status === 'running' && run.phase === 'arabic' ? 'Translating' : STATUS_LABEL[run.status]}</Badge>
              {run.result && downloaded.has(downloadId(run)) && <Badge>Downloaded</Badge>}
            </Flex>
            {run.result && (
              <Flex gap={2}>
                <Button variant="tertiary" size="S" aria-expanded={openKey === run.key} onClick={() => setOpenKey(openKey === run.key ? null : run.key)}>
                  {openKey === run.key ? 'Hide ads' : 'Review ads'}
                </Button>
                <Button size="S" startIcon={<Download />} onClick={() => downloadOne(run)}>
                  {run.result.arabic ? 'Arabic CSV' : 'CSV'} ({downloadableCsv(run.result).rows} rows)
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
