import * as React from 'react';
import { Alert, Badge, Box, Button, Flex, ProgressBar, Typography } from '@strapi/design-system';
import { Pagination } from '@strapi/strapi/admin';

import { BACKUP_RUNS_PAGE_SIZE_DEFAULT, type BackupOverview } from '../../../../constants/database-backup';
import { elapsedSince, formatBytes, formatDateTime, formatDuration, formatScheduledAt } from '../api';
import type { DatabaseBackupsState } from '../use-database-backups';
import { BackupHistoryTable } from './backup-history-table';
import { BackupNowDialog } from './backup-now-dialog';

const PAGE_SIZE_OPTIONS = ['10', '20', '50'];

/** Problem banners; each can be dismissed until the page is reopened. */
function Banners({ overview }: { overview: BackupOverview }) {
  const [dismissed, setDismissed] = React.useState<Record<string, boolean>>({});
  const dismiss = (key: string) => setDismissed((current) => ({ ...current, [key]: true }));
  const problems = overview.storage.problems;
  const banners: Array<{ key: string; variant: 'danger' | 'warning'; title: string; body: React.ReactNode }> = [];
  if (problems.length > 0) {
    banners.push({
      key: 'problems',
      variant: 'danger',
      title: 'Backups cannot run',
      body: (
        <Flex direction="column" alignItems="start" gap={1}>
          {problems.map((problem) => (
            <Typography key={problem} variant="pi">{problem}</Typography>
          ))}
        </Flex>
      ),
    });
  } else if (!overview.runner.healthy) {
    banners.push({
      key: 'runner',
      variant: 'warning',
      title: 'Backup runner is not reporting',
      body: (
        <Typography variant="pi">
          No container with BACKUP_RUNNER_ENABLED=true has sent a heartbeat recently
          {overview.runner.heartbeatAt ? ` (last ${formatDateTime(overview.runner.heartbeatAt)})` : ''}.
          Queued backups wait until it is back.
        </Typography>
      ),
    });
  }
  if (overview.stale) {
    banners.push({
      key: 'stale',
      variant: 'warning',
      title: 'Backups are overdue',
      body: (
        <Typography variant="pi">
          No backup has succeeded in more than twice the configured interval. Last success:{' '}
          {formatDateTime(overview.lastSuccess?.startedAt ?? null)}.
        </Typography>
      ),
    });
  }
  const visible = banners.filter((banner) => !dismissed[banner.key]);
  if (visible.length === 0) return null;
  return (
    <Flex direction="column" alignItems="stretch" gap={4}>
      {visible.map((banner) => (
        <Alert
          key={banner.key}
          variant={banner.variant}
          title={banner.title}
          closeLabel="Dismiss"
          onClose={() => dismiss(banner.key)}
        >
          {banner.body}
        </Alert>
      ))}
    </Flex>
  );
}

function ActiveRunCard({ state }: { state: DatabaseBackupsState }) {
  const run = state.overview?.activeRun;
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!run) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [run]);
  if (!run) return null;
  const elapsed = elapsedSince(run.startedAt, now);
  const previous = state.overview?.lastSuccess?.sizeBytes ?? null;
  const percent = previous && run.sizeBytes ? Math.min(99, Math.round((run.sizeBytes / previous) * 100)) : null;
  return (
    <Box padding={5} background="primary100" hasRadius>
      <Flex justifyContent="space-between" alignItems="center" gap={4} wrap="wrap">
        <Flex direction="column" alignItems="start" gap={1}>
          <Typography fontWeight="bold" textColor="primary700">
            {run.status === 'pending' ? 'Backup queued' : 'Backup in progress'}
          </Typography>
          <Typography variant="pi" textColor="primary700">
            {run.status === 'pending'
              ? 'Waiting for the backup runner to pick it up.'
              : `${formatBytes(run.sizeBytes)} uploaded · ${formatDuration(elapsed)} elapsed`}
            {run.cancelRequestedAt ? ' · cancelling…' : ''}
          </Typography>
          {percent !== null ? (
            <Box width="240px" paddingTop={1}>
              <ProgressBar value={percent} />
            </Box>
          ) : null}
        </Flex>
        <Button
          variant="danger-light"
          disabled={state.busy !== null || Boolean(run.cancelRequestedAt)}
          onClick={() => void state.cancelRun(run)}
        >
          Cancel
        </Button>
      </Flex>
    </Box>
  );
}

export function BackupsTab({ state }: { state: DatabaseBackupsState }) {
  const [confirming, setConfirming] = React.useState(false);
  const overview = state.overview!;
  const history = state.history;
  const canBackup = overview.storage.configured && !overview.activeRun;

  return (
    <Flex direction="column" alignItems="stretch" gap={6}>
      <Banners overview={overview} />

      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
        <Flex justifyContent="space-between" alignItems="flex-start" gap={4} wrap="wrap">
          <Flex direction="column" alignItems="start" gap={2}>
            <Typography variant="beta">Backups</Typography>
            <Flex gap={2} wrap="wrap">
              <Badge variant={overview.settings.scheduleEnabled ? 'success' : 'neutral'}>
                {overview.settings.scheduleEnabled
                  ? `Automatic · every ${overview.settings.intervalHours} h`
                  : 'Automatic backups off'}
              </Badge>
              <Badge variant={overview.runner.healthy ? 'success' : 'warning'}>
                {overview.runner.healthy ? 'Runner online' : 'Runner offline'}
              </Badge>
              {overview.lastSuccess ? (
                <Badge>{`Last success ${formatDateTime(overview.lastSuccess.startedAt)}`}</Badge>
              ) : (
                <Badge variant="warning">No successful backup yet</Badge>
              )}
              {overview.settings.scheduleEnabled ? (
                <Badge>{`Next ${formatScheduledAt(overview.nextScheduledAt)}`}</Badge>
              ) : null}
            </Flex>
          </Flex>
          <Button
            disabled={!canBackup || state.busy !== null}
            loading={state.busy === 'backup-now'}
            onClick={() => setConfirming(true)}
          >
            Back up now
          </Button>
        </Flex>
        <Box paddingTop={4}>
          <ActiveRunCard state={state} />
        </Box>
      </Box>

      <BackupHistoryTable
        runs={history?.runs ?? []}
        loading={!history}
        busy={state.busy}
        onCancel={state.cancelRun}
        onVerify={state.verifyRun}
        onDelete={state.deleteRun}
        onDownload={state.downloadRun}
      />
      <Pagination.Root
        pageCount={history?.pageCount ?? 1}
        total={history?.total ?? 0}
        defaultPageSize={BACKUP_RUNS_PAGE_SIZE_DEFAULT}
      >
        <Pagination.PageSize options={PAGE_SIZE_OPTIONS} />
        <Pagination.Links />
      </Pagination.Root>

      <BackupNowDialog open={confirming} onOpenChange={setConfirming} onConfirm={state.backupNow} />
    </Flex>
  );
}
