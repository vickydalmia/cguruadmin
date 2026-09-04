import * as React from 'react';
import {
  Badge,
  Box,
  Button,
  Dialog,
  Flex,
  Typography,
} from '@strapi/design-system';
import {
  ConfirmDialog,
  useFetchClient,
  useNotification,
} from '@strapi/strapi/admin';

import { translationError } from '../api';
import {
  formatCount,
  formatUsd,
  queueBusy,
  queueSummary,
  shortUid,
  unwrapBackfillEstimate,
  unwrapBackfillResult,
  unwrapOutboxStatus,
  type BackfillEstimate,
  type TranslationOutboxStatus,
} from '../backfill-api';

/**
 * Super-Admin backfill controls for Country Setup → AI content translation:
 * runtime/queue status, a dry-run cost estimate, and the catalogue-wide
 * "translate everything" trigger. Same endpoints as the runbook's
 * `POST /translation/backfill` — this is only a button in front of them.
 *
 * Hides itself for anyone the status endpoint refuses (it is Super-Admin
 * only server-side), so editors never see a control they cannot use.
 */

// Poll only while jobs are queued or running; a backfill lands over minutes
// to hours, so a slow cadence is plenty.
const ACTIVE_POLL_MS = 10_000;

function StatusBadges({ status }: { status: TranslationOutboxStatus }) {
  const summary = queueSummary(status);
  return (
    <Flex gap={2} wrap="wrap" alignItems="center">
      <Badge variant={status.enabled ? 'success' : 'danger'}>
        {status.enabled ? 'Translator active' : 'Translator not active'}
      </Badge>
      {status.dispatcher?.model ? <Badge>{status.dispatcher.model}</Badge> : null}
      <Badge variant={summary.pending ? 'primary' : 'neutral'}>{`${formatCount(summary.pending)} queued`}</Badge>
      <Badge variant={summary.processing ? 'primary' : 'neutral'}>{`${formatCount(summary.processing)} running`}</Badge>
      <Badge variant={summary.blocked ? 'warning' : 'neutral'}>{`${formatCount(summary.blocked)} blocked`}</Badge>
      <Badge variant={summary.failed ? 'danger' : 'neutral'}>{`${formatCount(summary.failed)} failed`}</Badge>
      <Badge variant="success">{`${formatCount(summary.deliveredToday)} done today`}</Badge>
      <Badge>
        {`${formatUsd(summary.costTodayUsd)} today${summary.dailyBudgetUsd ? ` of ${formatUsd(summary.dailyBudgetUsd)} budget` : ''}`}
      </Badge>
      {status.outbox?.backlogOverdue ? <Badge variant="warning">backlog overdue</Badge> : null}
    </Flex>
  );
}

function EstimateSummary({ estimate }: { estimate: BackfillEstimate }) {
  const perUid = Object.entries(estimate.perUid)
    .filter(([, entries]) => entries > 0)
    .map(([uid, entries]) => `${shortUid(uid)} ${formatCount(entries)}`)
    .join(' · ');
  return (
    <Box paddingTop={3}>
      <Typography variant="pi" textColor="neutral700">
        {`Estimate for ${estimate.locales.join(', ') || 'no languages'}: ` +
          `${formatCount(estimate.selected)} repairs selected, ` +
          `${formatCount(estimate.translatableChars)} characters, ` +
          `about ${formatCount(estimate.providerCallsExpected)} model calls, ` +
          `≈ ${formatUsd(estimate.estimatedUsd)}.`}
      </Typography>
      {perUid ? (
        <Typography tag="p" variant="pi" textColor="neutral600">{perUid}</Typography>
      ) : null}
      <Typography tag="p" variant="pi" textColor="neutral600">
        {`${formatCount(estimate.skippedCurrent)} current translations are skipped; memory-only and relation-only repairs do not call the provider.`}
      </Typography>
    </Box>
  );
}

export function TranslationBackfillCard({ translationEnabled }: { translationEnabled: boolean }) {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [status, setStatus] = React.useState<TranslationOutboxStatus | null>(null);
  const [hidden, setHidden] = React.useState(false);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [estimate, setEstimate] = React.useState<BackfillEstimate | null>(null);
  const [estimating, setEstimating] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [confirmingMode, setConfirmingMode] = React.useState<'all' | 'repair'>('all');

  const load = React.useCallback(async () => {
    try {
      setStatus(unwrapOutboxStatus(await get('/translation/outbox-status')));
      setStatusError(null);
    } catch (error: any) {
      // 403 = not a Super Admin: the controls are not for this user.
      if (error?.response?.status === 403) setHidden(true);
      else setStatusError(translationError(error));
    }
  }, [get]);

  React.useEffect(() => void load(), [load]);

  const busy = status ? queueBusy(queueSummary(status)) : false;
  React.useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const runEstimate = async () => {
    setEstimating(true);
    try {
      setEstimate(
        unwrapBackfillEstimate(await post('/translation/backfill', { dryRun: true, mode: 'repair' })),
      );
    } catch (error) {
      toggleNotification({ type: 'danger', message: translationError(error) });
    } finally {
      setEstimating(false);
    }
  };

  const runBackfill = async (mode: 'all' | 'repair') => {
    setRunning(true);
    try {
      const result = unwrapBackfillResult(await post('/translation/backfill', { mode }));
      toggleNotification({
        type: 'success',
        message: `Selected ${formatCount(result.selected)} and queued ${formatCount(result.enqueued)} job(s); ${formatCount(result.providerCallsExpected)} provider call(s) expected.`,
      });
      await load();
    } catch (error) {
      toggleNotification({ type: 'danger', message: translationError(error) });
    } finally {
      setRunning(false);
    }
  };

  if (hidden) return null;

  const active = status?.enabled === true;

  return (
    <Box paddingTop={5}>
      <Flex justifyContent="space-between" alignItems="flex-start" gap={4} wrap="wrap">
        <Box>
          <Typography fontWeight="bold">Translate the whole catalogue</Typography>
          <Typography tag="p" variant="pi" textColor="neutral600">
            Queues every localized entry (stores, brands, categories, coupons,
            deals, pages, UI text) for every enabled language. Safe to repeat:
            entries that are already current are skipped without a model call,
            so a re-run only picks up new, changed and previously failed
            entries. Results publish automatically as jobs complete.
          </Typography>
        </Box>
        <Flex gap={2}>
          <Button
            variant="secondary"
            size="S"
            loading={estimating}
            disabled={running}
            onClick={runEstimate}
          >
            Estimate repair
          </Button>
          <Button
            size="S"
            loading={running}
            disabled={!active || estimating}
            onClick={() => { setConfirmingMode('repair'); setConfirming(true); }}
          >
            Repair missing/failed translations
          </Button>
          <Button
            variant="tertiary"
            size="S"
            loading={running}
            disabled={!active || estimating}
            onClick={() => { setConfirmingMode('all'); setConfirming(true); }}
          >
            Queue all
          </Button>
        </Flex>
      </Flex>
      <Box paddingTop={3}>
        {status ? <StatusBadges status={status} /> : null}
        {statusError ? (
          <Typography tag="p" variant="pi" textColor="danger600">{statusError}</Typography>
        ) : null}
        {status && !active ? (
          <Typography tag="p" variant="pi" textColor="warning700">
            {translationEnabled
              ? 'The translator is not running on this CMS instance yet: save this page, make sure the TRANSLATION_* server environment is configured, then restart the CMS.'
              : 'Turn "Translation enabled" on and save before running a backfill.'}
          </Typography>
        ) : null}
        {status?.dispatcher?.lastError ? (
          <Typography tag="p" variant="pi" textColor="danger600">
            {`Dispatcher: ${status.dispatcher.lastError}`}
          </Typography>
        ) : null}
      </Box>
      {estimate ? <EstimateSummary estimate={estimate} /> : null}
      <Dialog.Root open={confirming} onOpenChange={setConfirming}>
        <ConfirmDialog
          title={confirmingMode === 'repair' ? 'Repair translations?' : 'Queue the whole catalogue?'}
          onConfirm={async () => {
            setConfirming(false);
            await runBackfill(confirmingMode);
          }}
        >
          {`${confirmingMode === 'repair' ? 'This selects only missing, stale, failed, blocked, incomplete-memory, and relation-drifted entries' : 'This queues every localized entry'}${
            estimate ? ` (whole-catalogue estimate ≈ ${formatUsd(estimate.estimatedUsd)})` : ''
          }. Current translations are provider-free no-ops. The daily budget cap still applies.`}
        </ConfirmDialog>
      </Dialog.Root>
    </Box>
  );
}
