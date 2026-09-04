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
  describeBackfillProgress,
  formatCount,
  formatUsd,
  queueBusy,
  queueSummary,
  shortUid,
  unwrapBackfillStart,
  unwrapOutboxStatus,
  type BackfillEstimate,
  type BackfillRun,
  type TranslationOutboxStatus,
} from '../backfill-api';

/**
 * Super-Admin backfill controls for Country Setup → AI content translation:
 * runtime/queue status, a dry-run cost estimate, and the repair / queue-all
 * triggers. Same endpoints as the runbook's `POST /translation/backfill` —
 * this is only a button in front of them.
 *
 * The CMS runs the catalogue scan in the background and answers at once with
 * a run state (the scan takes minutes on a real catalogue, past the proxy
 * timeout); this card polls `/translation/outbox-status`, whose `backfill`
 * field carries that run, and shows the estimate or result when it lands.
 *
 * Hides itself for anyone the status endpoint refuses (it is Super-Admin
 * only server-side), so editors never see a control they cannot use.
 */

// Poll only while jobs are queued or running; a backfill lands over minutes
// to hours, so a slow cadence is plenty — except while the scan itself runs,
// when its progress line is the only feedback.
const ACTIVE_POLL_MS = 10_000;
const RUN_POLL_MS = 3_000;

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
  const [starting, setStarting] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [confirmingMode, setConfirmingMode] = React.useState<'all' | 'repair'>('all');
  // The run this card started and still owes feedback for (estimate box or
  // completion toast). Runs started elsewhere (another tab, curl) only show
  // as progress.
  const trackedRun = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setStatus(unwrapOutboxStatus(await get('/translation/outbox-status')));
      setStatusError(null);
    } catch (error: any) {
      // 403 = not a Super Admin: the controls are not for this user. The
      // admin fetch client reports the HTTP status on `status`.
      if (error?.status === 403 || error?.response?.status === 403) setHidden(true);
      else setStatusError(translationError(error));
    }
  }, [get]);

  React.useEffect(() => void load(), [load]);

  const run: BackfillRun | null = status?.backfill ?? null;
  const running = run?.status === 'running';
  const busy = status ? queueBusy(queueSummary(status)) : false;
  React.useEffect(() => {
    if (!busy && !running) return;
    const timer = setInterval(() => void load(), running ? RUN_POLL_MS : ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, running, load]);

  // Completion of the run this card started: estimate → summary box; enqueue
  // → toast with the counts; failure → danger toast with the CMS error.
  React.useEffect(() => {
    if (!run || run.status === 'running' || trackedRun.current !== run.id) return;
    trackedRun.current = null;
    if (run.status === 'failed') {
      toggleNotification({
        type: 'danger',
        message: `${run.dryRun ? 'Estimate' : 'Backfill'} failed: ${run.error ?? 'unknown error'}`,
      });
      return;
    }
    if (run.dryRun) {
      if (run.result && typeof run.result.estimatedUsd === 'number') {
        setEstimate(run.result as BackfillEstimate);
      }
      return;
    }
    if (run.result) {
      toggleNotification({
        type: 'success',
        message:
          `Selected ${formatCount(run.result.selected)} and queued ` +
          `${formatCount(run.result.enqueued)} job(s); ` +
          `${formatCount(run.result.providerCallsExpected)} provider call(s) expected.`,
      });
    }
  }, [run, toggleNotification]);

  const start = async (payload: { mode: 'all' | 'repair'; dryRun?: boolean }) => {
    setStarting(true);
    try {
      const started = unwrapBackfillStart(await post('/translation/backfill', payload));
      trackedRun.current = started.id;
      setStatus((previous) => (previous ? { ...previous, backfill: started } : previous));
    } catch (error) {
      toggleNotification({ type: 'danger', message: translationError(error) });
    } finally {
      setStarting(false);
      void load();
    }
  };

  if (hidden) return null;

  const active = status?.enabled === true;
  const controlsLocked = starting || running;

  return (
    <Box paddingTop={5}>
      <Flex justifyContent="space-between" alignItems="flex-start" gap={4} wrap="wrap">
        <Box>
          <Typography fontWeight="bold">Translate the catalogue</Typography>
          <Typography tag="p" variant="pi" textColor="neutral600">
            Repair selects only entries whose translation is missing, stale,
            failed, blocked or incomplete (stores, brands, categories, coupons,
            deals, pages, UI text) for every enabled language; Queue all
            re-checks every entry. Both are safe to repeat: current entries
            cost no model call. The scan runs on the server for a few minutes
            and results publish automatically as jobs complete.
          </Typography>
        </Box>
        <Flex gap={2}>
          <Button
            variant="secondary"
            size="S"
            loading={starting}
            disabled={controlsLocked}
            onClick={() => void start({ mode: 'repair', dryRun: true })}
          >
            Estimate repair
          </Button>
          <Button
            size="S"
            loading={starting}
            disabled={!active || controlsLocked}
            onClick={() => { setConfirmingMode('repair'); setConfirming(true); }}
          >
            Repair missing/failed translations
          </Button>
          <Button
            variant="tertiary"
            size="S"
            loading={starting}
            disabled={!active || controlsLocked}
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
        {run?.status === 'running' ? (
          <Typography tag="p" variant="pi" textColor="primary600">
            {describeBackfillProgress(run)}
          </Typography>
        ) : null}
        {run?.status === 'failed' ? (
          <Typography tag="p" variant="pi" textColor="danger600">
            {`Last ${run.dryRun ? 'estimate' : 'backfill'} failed: ${run.error ?? 'unknown error'}`}
          </Typography>
        ) : null}
        {run?.status === 'done' && !run.dryRun && run.result ? (
          <Typography tag="p" variant="pi" textColor="neutral600">
            {`Last backfill (${run.mode}): selected ${formatCount(run.result.selected)}, ` +
              `queued ${formatCount(run.result.enqueued)}, ` +
              `${formatCount(run.result.skippedCurrent)} already current.`}
          </Typography>
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
            await start({ mode: confirmingMode });
          }}
        >
          {`${confirmingMode === 'repair' ? 'This selects only missing, stale, failed, blocked, incomplete-memory, and relation-drifted entries' : 'This re-checks every localized entry'}${
            estimate ? ` (repair estimate ≈ ${formatUsd(estimate.estimatedUsd)})` : ''
          }. Current translations are provider-free no-ops. The daily budget cap still applies.`}
        </ConfirmDialog>
      </Dialog.Root>
    </Box>
  );
}
