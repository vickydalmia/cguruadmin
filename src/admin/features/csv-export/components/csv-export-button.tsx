import * as React from 'react';
import { useAuth } from '@strapi/strapi/admin';
import {
  Button,
  Flex,
  Loader,
  Modal,
  ProgressBar,
  Typography,
} from '@strapi/design-system';
import { Download } from '@strapi/icons';
import { useParams } from 'react-router-dom';

import {
  CSV_EXPORT_TARGETS,
  isCsvExportUid,
  type CsvExportUid,
} from '../../../../constants/csv-export';
import { isSuperAdminUser } from '../../../utils/super-admin';
import { useCsvExport, type CsvExportState } from '../use-csv-export';

/**
 * "Export CSV" in the Coupon / Product Deal / Store / Brand / Category / Bank
 * list toolbars. Injected into `listView.actions` — the one list-view zone
 * Strapi 5 exposes (see OfferStatusTabs for the reasoning) — so it renders on
 * EVERY collection type and scopes itself by the route's model uid.
 *
 * Super Admin only. The check here only decides whether the button shows;
 * the admin-router policy on /csv-export/:uid is what enforces it.
 *
 * The export runs in a modal: the page loop lives in useCsvExport and keeps
 * going while the modal is open, the bar shows the exact row percentage
 * (page 1 carries the total), and closing the modal mid-run cancels.
 */

const formatCount = (value: number) => value.toLocaleString('en-IN');

function ExportBody({ state, label }: { state: CsvExportState; label: string }) {
  switch (state.status) {
    case 'running': {
      const progress = state.progress;
      if (!progress) {
        return (
          <Flex gap={3} alignItems="center">
            <Loader small>Preparing export</Loader>
            <Typography variant="pi" textColor="neutral600">
              Preparing export…
            </Typography>
          </Flex>
        );
      }
      return (
        <Flex direction="column" alignItems="stretch" gap={2}>
          <ProgressBar value={progress.percent} aria-label="Export progress" />
          <Typography variant="pi" textColor="neutral600">
            Exported {formatCount(progress.done)} of {formatCount(progress.total)} entries
            {' '}({progress.percent}%) — page {formatCount(progress.page)} of{' '}
            {formatCount(progress.pageCount)}
          </Typography>
          <Typography variant="pi" textColor="neutral500">
            The file downloads automatically when it reaches 100%. Entries saved
            while the export runs may not be included.
          </Typography>
        </Flex>
      );
    }
    case 'done':
      return (
        <Flex direction="column" alignItems="stretch" gap={2}>
          <ProgressBar value={100} aria-label="Export progress" />
          <Typography variant="omega">
            Downloaded <strong>{state.fileName}</strong> ({formatCount(state.rows)} rows).
          </Typography>
          <Typography variant="pi" textColor="neutral600">
            The file is UTF-8 with a BOM, so it opens correctly in Excel and
            Numbers. Related entries are listed by name or title; repeatable
            sections such as FAQs are JSON.
          </Typography>
        </Flex>
      );
    case 'cancelled':
      return (
        <Typography variant="omega" textColor="neutral600">
          Export cancelled. Nothing was downloaded.
        </Typography>
      );
    case 'error':
      return (
        <Typography variant="omega" textColor="danger600">
          {state.message}
        </Typography>
      );
    default:
      return (
        <Typography variant="omega" textColor="neutral600">
          Exports every {label.toLowerCase()} entry with all of its fields.
        </Typography>
      );
  }
}

function ExportDialog({
  uid,
  onClose,
}: {
  uid: CsvExportUid;
  onClose: () => void;
}) {
  const { label } = CSV_EXPORT_TARGETS[uid];
  const { state, start, cancel } = useCsvExport(uid);
  const running = state.status === 'running';

  // Kick off as soon as the dialog opens: the button is the confirmation.
  React.useEffect(() => {
    void start();
  }, [start]);

  const close = () => {
    if (running) cancel();
    onClose();
  };

  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && close()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{`Export ${label} to CSV`}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <ExportBody state={state} label={label} />
        </Modal.Body>
        <Modal.Footer>
          {running ? (
            <Button variant="tertiary" onClick={close}>
              Cancel
            </Button>
          ) : (
            <Button variant="tertiary" onClick={onClose}>
              Close
            </Button>
          )}
          {state.status === 'error' || state.status === 'cancelled' ? (
            <Button startIcon={<Download />} onClick={() => void start()}>
              Try again
            </Button>
          ) : null}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

const CsvExportButton = () => {
  const { slug } = useParams<{ slug: string }>();
  const user = useAuth('CsvExportButton', (auth) => auth.user);
  const [open, setOpen] = React.useState(false);

  // Hooks above, scoping below: the zone renders on every collection type.
  if (!isCsvExportUid(slug) || !isSuperAdminUser(user)) return null;

  return (
    <>
      <Button
        size="S"
        variant="tertiary"
        startIcon={<Download />}
        onClick={() => setOpen(true)}
      >
        Export CSV
      </Button>
      {open ? <ExportDialog uid={slug} onClose={() => setOpen(false)} /> : null}
    </>
  );
};

export default CsvExportButton;
