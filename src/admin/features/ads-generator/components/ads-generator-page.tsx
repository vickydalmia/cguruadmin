import * as React from 'react';
import { Box, Flex, Typography } from '@strapi/design-system';
import { Layouts, Page, useFetchClient } from '@strapi/strapi/admin';
import type { AdsGeneratorJob, AdsGeneratorOptions } from '../../../../constants/ads-generator';
import { adsGeneratorApi, adsGeneratorError, EMPTY_FORM, progressLabel, type AdsGeneratorFailure } from '../api';
import { useAdsGeneration } from '../use-ads-generation';
import { AdsForm } from './ads-form';
import { AdsResult } from './ads-result';

/**
 * Settings → Ads Generator. Access is the "Generate Google Ads" role
 * permission; the settings link hides itself without it, and a 403 from
 * `global::ads-generator-manage-only` renders NoPermissions.
 */
export default function AdsGeneratorPage() {
  const client = useFetchClient();
  const api = React.useMemo(() => adsGeneratorApi(client), [client.get, client.post]);
  const [options, setOptions] = React.useState<AdsGeneratorOptions | null>(null);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [loadFailure, setLoadFailure] = React.useState<AdsGeneratorFailure | null>(null);
  const generation = useAdsGeneration(api);
  const failure = loadFailure ?? generation.failure;

  React.useEffect(() => {
    let active = true;
    api.options().then((value) => { if (active) setOptions(value); })
      .catch((error) => { if (active) setLoadFailure(adsGeneratorError(error)); });
    return () => { active = false; };
  }, [api]);

  if (failure?.forbidden) return <Page.NoPermissions />;
  if (!options && !failure) return <Page.Loading />;

  return (
    <Page.Main>
      <Page.Title>Ads Generator</Page.Title>
      <Layouts.Header
        title="Ads Generator"
        subtitle="Generate a Google Ads Search campaign upload CSV for one brand."
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
              <AdsForm options={options} value={form} onChange={setForm} onSubmit={() => void generation.start(form)} busy={generation.busy} />
            </Box>
          )}
          {generation.job?.status === 'running' && <ProgressNotice job={generation.job} />}
          {generation.result && (
            <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
              <AdsResult result={generation.result} />
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
