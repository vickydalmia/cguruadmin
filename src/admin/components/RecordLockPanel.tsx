import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { useFetchClient } from '@strapi/strapi/admin';
import { Button, Dialog, Flex, Status, Typography } from '@strapi/design-system';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * "Edit lock" side panel — single-editor guard for every Content Manager edit
 * view. On mount it claims the lock for this entry (POST /record-lock/acquire,
 * admin router — see src/index.ts) and re-claims it every HEARTBEAT_MS so the
 * server-side 90 s TTL never lapses while the tab is open. When another admin
 * already holds the lock, a blocking dialog names them and asks the editor to
 * come back later.
 *
 * The dialog is dismissible on purpose: viewing a locked entry is harmless,
 * and saving is refused SERVER-SIDE by the document middleware in
 * src/index.ts, so ignoring the warning cannot overwrite the holder's work.
 * While blocked, the same heartbeat keeps retrying — the moment the holder
 * leaves (or their lock expires) it flips to "locked by you" automatically.
 */

const HEARTBEAT_MS = 20_000;

type Holder = { adminUserId: number; holderName: string; expiresAt: string };
type AcquireResponse =
  | { acquired: true; expiresAt: string }
  | { acquired: false; holder: Holder };

type LockState =
  | { phase: 'pending' }
  | { phase: 'mine' }
  | { phase: 'blocked'; holder: Holder };

const RecordLockPanel: PanelComponent = ({ model, documentId }) => {
  const { post } = useFetchClient();
  const navigate = useNavigate();
  const [state, setState] = React.useState<LockState>({ phase: 'pending' });
  // Dialog is re-armed if the holder CHANGES, but stays dismissed while the
  // same person keeps holding the lock (no nag loop on every heartbeat).
  const [dismissedFor, setDismissedFor] = React.useState<number | null>(null);
  const phaseRef = React.useRef<LockState['phase']>('pending');
  phaseRef.current = state.phase;

  // New entries have no documentId yet — nothing exists to lock until the
  // first save navigates to the created document's edit URL. Plugin content
  // types (upload folders, users-permissions…) are outside the lock API's
  // api:: scope.
  const lockable = Boolean(documentId) && model.startsWith('api::');

  React.useEffect(() => {
    if (!lockable) return undefined;

    let alive = true;
    const attempt = async () => {
      try {
        const { data } = await post<AcquireResponse>('/record-lock/acquire', {
          model,
          documentId,
        });
        if (!alive) return;
        setState(
          data.acquired
            ? { phase: 'mine' }
            : { phase: 'blocked', holder: data.holder },
        );
      } catch {
        // Network hiccup or server restart: keep the last known state and let
        // the next heartbeat retry. Saves stay guarded server-side either way.
      }
    };

    void attempt();
    const timer = window.setInterval(() => void attempt(), HEARTBEAT_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
      // Free the entry for the next editor immediately instead of making
      // them wait out the TTL. Only meaningful if the lock was ours; the
      // server ignores a release from a non-holder.
      if (phaseRef.current === 'mine') {
        void post('/record-lock/release', { model, documentId }).catch(
          () => undefined,
        );
      }
    };
  }, [lockable, model, documentId, post]);

  if (!lockable) return null;

  if (state.phase === 'blocked') {
    const { holder } = state;
    const dialogOpen = dismissedFor !== holder.adminUserId;
    return {
      title: 'Edit lock',
      content: (
        <Flex direction="column" alignItems="stretch" gap={2}>
          <Status variant="danger" size="S">
            <Typography>
              <Typography fontWeight="bold">{holder.holderName}</Typography>
              {' is editing this entry right now. You cannot save until they '}
              finish — come back later.
            </Typography>
          </Status>
          <Dialog.Root
            open={dialogOpen}
            onOpenChange={(open: boolean) => {
              if (!open) setDismissedFor(holder.adminUserId);
            }}
          >
            <Dialog.Content>
              <Dialog.Header>Entry is being edited</Dialog.Header>
              <Dialog.Body>
                {`${holder.holderName} is currently working on this entry. ` +
                  'Please come back later — any save you attempt now will be ' +
                  'rejected so their changes are not overwritten.'}
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.Cancel>
                  <Button
                    variant="tertiary"
                    onClick={() => setDismissedFor(holder.adminUserId)}
                  >
                    View anyway
                  </Button>
                </Dialog.Cancel>
                <Dialog.Action>
                  <Button onClick={() => navigate(-1)}>Go back</Button>
                </Dialog.Action>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Root>
        </Flex>
      ),
    };
  }

  if (state.phase === 'mine') {
    return {
      title: 'Edit lock',
      content: (
        <Status variant="success" size="S">
          <Typography>
            Locked by you — other admins are told to come back later.
          </Typography>
        </Status>
      ),
    };
  }

  // First acquire still in flight: no panel flash for the common case.
  return null;
};

export default RecordLockPanel;
