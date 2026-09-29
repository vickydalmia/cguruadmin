import * as React from 'react';
import { useFetchClient, useNotification, useQueryParams } from '@strapi/strapi/admin';

import {
  BACKUP_RUNS_PAGE_SIZE_DEFAULT,
  type BackupConnectionTest,
  type BackupOverview,
  type BackupRunView,
  type BackupRunsPage,
  type BackupSettings,
} from '../../../constants/database-backup';
import { startPoll } from '../../utils/poll';
import {
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
  OVERVIEW_PATH,
  RUNS_PATH,
  SETTINGS_PATH,
  TEST_CONNECTION_PATH,
  activityInFlight,
  backupError,
  isForbidden,
  runActionPath,
  runPath,
  runsPath,
  unwrapConnectionTest,
  unwrapDownloadUrl,
  unwrapOverview,
  unwrapRun,
  unwrapRuns,
  unwrapSettings,
} from './api';

/**
 * Page state + every request the Database Backups page makes. One poll loop
 * (src/admin/utils/poll.ts) refreshes overview and history together: fast
 * while a backup or verification is running, slowly otherwise, and `kick`ed
 * right after any action so the table reflects it without waiting.
 */

type Query = { page?: string; pageSize?: string };

export function useDatabaseBackups() {
  const { get, post, put, del } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [{ query }] = useQueryParams<Query>({ page: '1', pageSize: String(BACKUP_RUNS_PAGE_SIZE_DEFAULT) });
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || BACKUP_RUNS_PAGE_SIZE_DEFAULT;

  const [overview, setOverview] = React.useState<BackupOverview | null>(null);
  const [history, setHistory] = React.useState<BackupRunsPage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [forbidden, setForbidden] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const pollRef = React.useRef<ReturnType<typeof startPoll> | null>(null);
  const pageRef = React.useRef({ page, pageSize });
  pageRef.current = { page, pageSize };

  React.useEffect(() => {
    const poll = startPoll(async (alive) => {
      try {
        const [overviewResponse, runsResponse] = await Promise.all([
          get(OVERVIEW_PATH),
          get(runsPath(pageRef.current.page, pageRef.current.pageSize)),
        ]);
        if (!alive()) return null;
        const nextOverview = unwrapOverview(overviewResponse);
        const nextHistory = unwrapRuns(runsResponse);
        setOverview(nextOverview);
        setHistory(nextHistory);
        setError(null);
        setLoading(false);
        return activityInFlight(nextOverview, nextHistory.runs) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      } catch (caught) {
        if (!alive()) return null;
        if (isForbidden(caught)) {
          setForbidden(true);
          setLoading(false);
          return null;
        }
        setError(backupError(caught, 'Database backups are unavailable.'));
        setLoading(false);
        return IDLE_POLL_MS;
      }
    });
    pollRef.current = poll;
    return () => {
      poll.stop();
      pollRef.current = null;
    };
  }, [get]);

  // A page change must refetch at once, not on the next idle tick.
  React.useEffect(() => {
    pollRef.current?.kick();
  }, [page, pageSize]);

  const refresh = React.useCallback(() => pollRef.current?.kick(), []);

  // Resolves true only when the work completed; a failure is shown as a
  // notification and reported as false so callers (the settings form) can
  // keep their local state for a retry instead of treating it as saved.
  const act = React.useCallback(
    async (label: string, work: () => Promise<void>): Promise<boolean> => {
      setBusy(label);
      try {
        await work();
        return true;
      } catch (caught) {
        toggleNotification({ type: 'danger', message: backupError(caught) });
        return false;
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh, toggleNotification],
  );

  const backupNow = (note: string | null) =>
    act('backup-now', async () => {
      await post(RUNS_PATH, { note });
      toggleNotification({ type: 'success', message: 'Backup queued. It starts within about 30 seconds.' });
    });

  const cancelRun = (run: BackupRunView) =>
    act(`cancel:${run.id}`, async () => {
      await post(runActionPath(run.id, 'cancel'), {});
      toggleNotification({ type: 'warning', message: 'Cancellation requested.' });
    });

  const verifyRun = (run: BackupRunView) =>
    act(`verify:${run.id}`, async () => {
      await post(runActionPath(run.id, 'verify'), {});
      toggleNotification({ type: 'success', message: 'Verification queued.' });
    });

  const deleteRun = (run: BackupRunView) =>
    act(`delete:${run.id}`, async () => {
      const response = await del(runPath(run.id));
      const updated = unwrapRun(response);
      toggleNotification({
        type: 'success',
        message: updated?.status === 'deleted' ? 'Backup deleted from storage.' : 'Backup delete requested.',
      });
    });

  const downloadRun = (run: BackupRunView) =>
    act(`download:${run.id}`, async () => {
      const url = unwrapDownloadUrl(await get(runActionPath(run.id, 'download-url')));
      // Same-tab navigation: the presigned URL carries
      // `Content-Disposition: attachment`, so the browser saves the file and
      // the admin page stays put. A popup opened after the signing round trip
      // would be blocked (Safari always, others once the click's activation
      // window has passed) without any error to show.
      window.location.assign(url);
    });

  /** True once the server accepted the settings; false leaves the form dirty. */
  const saveSettings = (settings: BackupSettings): Promise<boolean> =>
    act('save-settings', async () => {
      const saved = unwrapSettings(await put(SETTINGS_PATH, { data: settings }));
      setOverview((current) => (current ? { ...current, settings: saved } : current));
      toggleNotification({ type: 'success', message: 'Backup settings saved.' });
    });

  const [connectionTest, setConnectionTest] = React.useState<BackupConnectionTest | null>(null);
  const testConnection = () =>
    act('test-connection', async () => {
      setConnectionTest(unwrapConnectionTest(await post(TEST_CONNECTION_PATH, {})));
    });

  return {
    overview,
    history,
    loading,
    forbidden,
    error,
    busy,
    page,
    pageSize,
    refresh,
    backupNow,
    cancelRun,
    verifyRun,
    deleteRun,
    downloadRun,
    saveSettings,
    connectionTest,
    testConnection,
  };
}

export type DatabaseBackupsState = ReturnType<typeof useDatabaseBackups>;
