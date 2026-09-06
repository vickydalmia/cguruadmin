import * as React from 'react';
import { Badge, Button, Dialog, Flex, Status, Typography, type StatusVariant } from '@strapi/design-system';
import { Check, Cross, Download, Trash } from '@strapi/icons';
import { ConfirmDialog, Table } from '@strapi/strapi/admin';

import type { BackupRunStatus, BackupRunView, BackupVerifyState } from '../../../../constants/database-backup';
import { describeTrigger, formatBytes, formatDateTime, formatDuration } from '../api';

// Date · Type · Note · Size · Duration · Status · Verified · Actions.
// Presentational — requests live in ../use-database-backups.

const STATUS_LABEL: Record<BackupRunStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  succeeded: 'Stored',
  failed: 'Failed',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
};

const STATUS_VARIANT: Record<BackupRunStatus, StatusVariant> = {
  pending: 'secondary',
  running: 'primary',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'warning',
  deleted: 'neutral',
};

const VERIFY_LABEL: Record<BackupVerifyState, string> = {
  pending: 'Verifying…',
  running: 'Verifying…',
  ok: 'Verified',
  failed: 'Verify failed',
};

const HEADERS = [
  { name: 'date', label: 'Date', sortable: false },
  { name: 'type', label: 'Type', sortable: false },
  { name: 'note', label: 'Note', sortable: false },
  { name: 'size', label: 'Size', sortable: false },
  { name: 'duration', label: 'Duration', sortable: false },
  { name: 'status', label: 'Status', sortable: false },
  { name: 'actions', label: 'Actions', sortable: false },
];

function VerifyBadge({ run }: { run: BackupRunView }) {
  if (!run.verifyState) return null;
  const variant = run.verifyState === 'ok' ? 'success' : run.verifyState === 'failed' ? 'danger' : 'secondary';
  const title = run.verifyState === 'ok' && run.verifyTocEntries !== null
    ? `${run.verifyTocEntries} archive entries`
    : run.verifyError ?? undefined;
  return (
    <Badge variant={variant} size="S" title={title}>
      {VERIFY_LABEL[run.verifyState]}
    </Badge>
  );
}

export function BackupHistoryTable({
  runs,
  loading,
  busy,
  onCancel,
  onVerify,
  onDelete,
  onDownload,
}: {
  runs: BackupRunView[];
  loading: boolean;
  busy: string | null;
  onCancel: (run: BackupRunView) => Promise<unknown>;
  onVerify: (run: BackupRunView) => Promise<unknown>;
  onDelete: (run: BackupRunView) => Promise<unknown>;
  onDownload: (run: BackupRunView) => Promise<unknown>;
}) {
  const [deleting, setDeleting] = React.useState<BackupRunView | null>(null);
  const rows = runs.map((run) => ({ id: run.id, run }));

  return (
    <>
      <Table.Root rows={rows} headers={HEADERS} isLoading={loading}>
        <Table.Content>
          <Table.Head>
            {HEADERS.map((header) => (
              <Table.HeaderCell key={header.name} {...header} />
            ))}
          </Table.Head>
          <Table.Loading>Loading backups…</Table.Loading>
          <Table.Empty content="No backups yet. Use “Back up now” or enable the schedule in Backup Settings." />
          <Table.Body>
            {rows.map(({ id, run }) => {
              const active = run.status === 'pending' || run.status === 'running';
              const stored = run.status === 'succeeded';
              const verifying = run.verifyState === 'pending' || run.verifyState === 'running';
              return (
                <Table.Row key={id}>
                  <Table.Cell>
                    <Typography variant="pi">{formatDateTime(run.startedAt ?? run.createdAt)}</Typography>
                  </Table.Cell>
                  <Table.Cell>
                    <Typography variant="pi">{describeTrigger(run)}</Typography>
                  </Table.Cell>
                  <Table.Cell>
                    <Typography variant="pi" textColor={run.note ? 'neutral800' : 'neutral500'}>
                      {run.note ?? '—'}
                    </Typography>
                  </Table.Cell>
                  <Table.Cell>
                    <Typography variant="pi">{formatBytes(run.sizeBytes)}</Typography>
                  </Table.Cell>
                  <Table.Cell>
                    <Typography variant="pi">{formatDuration(run.durationMs)}</Typography>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex direction="column" alignItems="start" gap={1}>
                      <Status variant={STATUS_VARIANT[run.status]} size="S" title={run.error ?? undefined}>
                        <Typography variant="pi" fontWeight="bold">
                          {STATUS_LABEL[run.status]}
                        </Typography>
                      </Status>
                      <VerifyBadge run={run} />
                      {run.error && (run.status === 'failed' || run.status === 'pending') ? (
                        <Typography variant="pi" textColor="danger600" style={{ maxWidth: 320 }}>
                          {run.error}
                        </Typography>
                      ) : null}
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex gap={2} wrap="wrap">
                      {active ? (
                        <Button
                          variant="danger-light"
                          size="S"
                          startIcon={<Cross />}
                          disabled={busy !== null || Boolean(run.cancelRequestedAt)}
                          onClick={() => void onCancel(run)}
                        >
                          {run.cancelRequestedAt ? 'Cancelling…' : 'Cancel'}
                        </Button>
                      ) : null}
                      {stored ? (
                        <>
                          <Button
                            variant="tertiary"
                            size="S"
                            startIcon={<Download />}
                            disabled={busy !== null}
                            onClick={() => void onDownload(run)}
                          >
                            Download
                          </Button>
                          <Button
                            variant="tertiary"
                            size="S"
                            startIcon={<Check />}
                            disabled={busy !== null || verifying}
                            onClick={() => void onVerify(run)}
                          >
                            Verify
                          </Button>
                          <Button
                            variant="danger-light"
                            size="S"
                            startIcon={<Trash />}
                            disabled={busy !== null}
                            onClick={() => setDeleting(run)}
                          >
                            Delete
                          </Button>
                        </>
                      ) : null}
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Content>
      </Table.Root>

      <Dialog.Root open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <ConfirmDialog
          title="Delete this backup from storage?"
          onConfirm={async () => {
            const run = deleting;
            setDeleting(null);
            if (run) await onDelete(run);
          }}
        >
          {deleting
            ? `The archive from ${formatDateTime(deleting.startedAt)} (${formatBytes(deleting.sizeBytes)}) is removed from the bucket. With bucket versioning on it can still be recovered by an operator.`
            : ''}
        </ConfirmDialog>
      </Dialog.Root>
    </>
  );
}
