import * as React from 'react';
import { Box, Flex, Typography } from '@strapi/design-system';
import { Layouts, Page, useFetchClient } from '@strapi/strapi/admin';
import { ADS_LLM_LIMITS, type AdsGeneratorJob, type AdsGeneratorOptions } from '../../../../constants/ads-generator';
import { useGenerationJob } from '../../../utils/use-generation-job';
import { adsGeneratorApi, adsGeneratorError, JOB_STORAGE_KEY, newRow, progressLabel, restoredRows, retryRequest, type AdsGeneratorFailure, type CampaignRow } from '../api';
import { AdsForm } from './ads-form';
import { AdsBatchResult } from './ads-batch-result';

const GENERATION_SETTINGS = { storageKey: JOB_STORAGE_KEY, pollMs: ADS_LLM_LIMITS.jobPollMs, toFailure: adsGeneratorError };

/**
 * Settings → Ads Generator. Access is the "Generate Google Ads" role
 * permission; the settings link hides itself without it, and a 403 from
 * `global::ads-generator-manage-only` renders NoPermissions.
 */
export default function AdsGeneratorPage() {
  const client = useFetchClient();
  const api = React.useMemo(() => adsGeneratorApi(client), [client.get, client.post]);
  const [options, setOptions] = React.useState<AdsGeneratorOptions | null>(null);
  const [rows, setRows] = React.useState<CampaignRow[]>(() => [newRow()]);
  // Which row produced each campaign of the current job, for retrying with fixes.
  const [submittedIds, setSubmittedIds] = React.useState<string[]>([]);
  const [loadFailure, setLoadFailure] = React.useState<AdsGeneratorFailure | null>(null);
  const generation = useGenerationJob(api, GENERATION_SETTINGS);
  const failure = loadFailure ?? generation.failure;

  React.useEffect(() => {
    let active = true;
    api.options().then((value) => { if (active) setOptions(value); })
      .catch((error) => { if (active) setLoadFailure(adsGeneratorError(error)); });
    return () => { active = false; };
  }, [api]);

  React.useEffect(() => {
    const restored = restoredRows(generation.restoredInput);
    if (!restored) return;
    setRows(restored);
    setSubmittedIds(restored.map((row) => row.id));
  }, [generation.restoredInput]);

  const submit = async () => {
    const accepted = await generation.start({ campaigns: rows.map((row) => row.value) });
    if (accepted) setSubmittedIds(rows.map((row) => row.id));
  };
  const retry = () => {
    if (generation.job) void generation.start(retryRequest(generation.job, rows, submittedIds));
  };
  const newBatch = async () => {
    if (!(await generation.reset())) return;
    setRows([newRow()]);
    setSubmittedIds([]);
  };
  const runs = generation.job?.result?.campaigns ?? [];

  if (failure?.forbidden) return <Page.NoPermissions />;
  if (!options && !failure) return <Page.Loading />;

  return (
    <Page.Main>
      <Page.Title>Ads Generator</Page.Title>
      <Layouts.Header
        title="Ads Generator"
        subtitle="Generate Google Ads Search campaign upload CSVs, up to 10 campaigns at once."
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6}>
          {options && !options.configured && (
            <Typography textColor="danger600">
              Not configured: set ADS_GENERATOR_OPENAI_API_KEY and ADS_GENERATOR_MODEL on the server.
            </Typography>
          )}
          {failure && <FailureNotice failure={failure} />}
          {options && (
            <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
              <AdsForm options={options} rows={rows} onChange={setRows} onSubmit={() => void submit()} onNewBatch={() => void newBatch()} busy={generation.busy} recovering={generation.recovering} />
            </Box>
          )}
          {generation.job?.status === 'running' && <ProgressNotice job={generation.job} />}
          {runs.length > 0 && (
            <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
              <AdsBatchResult runs={runs} busy={generation.busy} onRetry={retry} />
            </Box>
          )}
        </Flex>
      </Layouts.Content>
    </Page.Main>
  );
}

function ProgressNotice({ job }: { job: AdsGeneratorJob }) {
  return (
    <Box role="status" background="primary100" padding={4} hasRadius>
      <Typography fontWeight="bold" textColor="primary700">{progressLabel(job)}</Typography>
      <Typography tag="p" textColor="primary700">
        {job.reattached ? 'A generation you started earlier is still running; showing it here. ' : ''}
        This can take a few minutes. You can stay on this page or reload it; the result will appear here.
      </Typography>
    </Box>
  );
}

function FailureNotice({ failure }: { failure: AdsGeneratorFailure }) {
  return (
    <Box role="alert" background="danger100" padding={4} hasRadius>
      <Typography fontWeight="bold" textColor="danger700">{failure.message}</Typography>
      {failure.problems.length > 0 && (
        <ul>{failure.problems.map((problem) => <li key={problem}><Typography textColor="danger700">• {problem}</Typography></li>)}</ul>
      )}
    </Box>
  );
}
