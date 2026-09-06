// Catalogue sync state: version + deployment sync time + counts, the selected
// language's translation counts and its newest job — or the empty state
// while no storefront deployment has synchronized its catalogue yet.
import * as React from 'react';
import { Badge, Box, Flex, Typography } from '@strapi/design-system';

import { ENGLISH_CODE, type UiDictionaryStatus } from '../types';

export const NO_CATALOGUE_MESSAGE =
  "Waiting for a storefront deployment to sync its catalogue — check the deployment log and the token's `ui-dictionary.syncCatalogue` permission.";

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SyncStatusCard({ status, locale }: { status: UiDictionaryStatus; locale: string }) {
  const { catalogue, perLocale } = status;
  if (!catalogue) {
    return (
      <Box padding={5} background="warning100" borderColor="warning200" hasRadius>
        <Typography textColor="warning700">{NO_CATALOGUE_MESSAGE}</Typography>
      </Box>
    );
  }
  const counts = locale === ENGLISH_CODE ? null : perLocale.locales[locale];
  const job = status.jobs?.[locale] ?? null;
  return (
    <Box padding={4} background="neutral0" shadow="filterShadow" hasRadius>
      <Flex gap={3} wrap="wrap" alignItems="center">
        <Badge>{`catalogue ${catalogue.version.slice(0, 12)}`}</Badge>
        <Typography variant="pi" textColor="neutral600">{`synced ${formatTime(catalogue.pushedAt)}`}</Typography>
        <Badge>{`${perLocale.catalogue.total} keys`}</Badge>
        <Badge>{`${perLocale.catalogue.overridden} overridden`}</Badge>
        {perLocale.catalogue.removed > 0 ? <Badge>{`${perLocale.catalogue.removed} removed`}</Badge> : null}
        {counts ? (
          <>
            <Badge variant="success">{`${counts.translated} translated`}</Badge>
            <Badge variant={counts.missing ? 'danger' : 'neutral'}>{`${counts.missing} missing`}</Badge>
            <Badge variant={counts.stale ? 'warning' : 'neutral'}>{`${counts.stale} out of date`}</Badge>
            <Badge>{`${counts.manual} manual`}</Badge>
          </>
        ) : null}
        {job ? (
          <Badge variant={job.status === 'failed' ? 'danger' : job.status === 'delivered' ? 'success' : 'primary'}>
            {`job ${job.status}${job.attemptCount > 1 ? ` (attempt ${job.attemptCount})` : ''}`}
          </Badge>
        ) : null}
        {!status.translationActive && locale !== ENGLISH_CODE ? (
          <Typography variant="pi" textColor="danger600">
            Translation is off on this deployment — manual edits and imports still work.
          </Typography>
        ) : null}
      </Flex>
      {job?.lastError ? (
        <Typography tag="p" variant="pi" textColor="danger600">{job.lastError}</Typography>
      ) : null}
    </Box>
  );
}
