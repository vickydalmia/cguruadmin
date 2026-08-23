import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import {
  Button,
  Dialog,
  Flex,
  Status,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { useReadOnlyEditForm } from './read-only-form';
import { useRecordLock } from './use-record-lock';

/**
 * "Edit lock" side panel — single-editor guard for every Content Manager edit
 * view. On mount it claims the lock for this entry (POST /record-lock/acquire,
 * admin router — see src/register/admin-routes.ts) and re-claims it every HEARTBEAT_MS so the
 * server-side 90 s TTL never lapses while the tab is open.
 *
 * When another admin already holds the lock the view is hard-blocked, three
 * layers deep (acquisition/heartbeat/takeover: ./use-record-lock;
 * response contract: ./record-lock-protocol; form freeze: ./read-only-form):
 *   1. a modal that CANNOT be dismissed (no cancel, Esc and outside clicks
 *      are swallowed) — leaving for the list view is the only way out, plus
 *      "Take over" when the holder is another session of the SAME admin
 *      (e.g. the lease a page reload orphaned);
 *   2. the edit form is greyed out and made `inert` (unclickable, untypable,
 *      unfocusable) until this exact tab owns the lock;
 *   3. the server rejects the save anyway (document middleware in
 *      src/register/record-lock-document.ts) — the DOM layers are UX, the
 *      middleware is the guarantee.
 * The same heartbeat keeps retrying while blocked — the moment the holder
 * leaves (or their lock expires) the modal closes and the form re-enables
 * automatically.
 */

const RecordLockPanel: PanelComponent = ({
  model,
  documentId,
  collectionType,
}) => {
  const navigate = useNavigate();
  const { state, lockable, isSingleType, blocked, mine, readOnly, takeover } =
    useRecordLock({ model, documentId, collectionType });
  useReadOnlyEditForm(readOnly);

  if (!lockable) return null;

  if (blocked && state.phase === 'blocked') {
    const { holder, self } = state;
    // history.go(-1) is a no-op in a fresh tab (cmd-click, pasted URL), which
    // would strand the editor behind a modal with a dead button — so leave to
    // an explicit destination instead. Single types have no list view; the
    // Content Manager home is the nearest safe landing.
    const escapeTo = isSingleType
      ? '/content-manager'
      : `/content-manager/collection-types/${model}`;
    const escapeLabel = isSingleType ? 'Back to Content Manager' : 'Back to list';
    return {
      title: 'Edit lock',
      content: (
        <Flex direction="column" alignItems="stretch" gap={2}>
          <Status variant="danger" size="S">
            <Typography>
              {self ? (
                'You have this entry open in another tab or a previous session.'
              ) : (
                <>
                  <Typography fontWeight="bold">{holder.holderName}</Typography>
                  {' is editing this entry right now — come back later.'}
                </>
              )}
            </Typography>
          </Status>
          {/* Deliberately NOT dismissible: open is pinned to the blocked
              state, so Esc / outside clicks are ignored and there is no
              cancel button. It closes only when the holder finishes (the
              heartbeat flips the state), a self-lock is taken over, or the
              editor leaves. */}
          <Dialog.Root open onOpenChange={() => undefined}>
            <Dialog.Content>
              <Dialog.Header>
                {self ? 'You are editing this elsewhere' : 'Entry is being edited'}
              </Dialog.Header>
              <Dialog.Body>
                {self
                  ? 'Another of your own tabs — or a session ended by a page ' +
                    'reload — still holds the edit lock on this entry. If ' +
                    'that other tab is closed, take the lock over and ' +
                    'continue here; otherwise finish there first.'
                  : `${holder.holderName} is currently working on this entry. ` +
                    'Editing is locked so their changes are not overwritten — ' +
                    'please come back later. This screen unlocks by itself ' +
                    'the moment they finish.'}
              </Dialog.Body>
              <Dialog.Footer>
                {self ? (
                  <>
                    <Dialog.Cancel>
                      <Button
                        variant="tertiary"
                        onClick={() => navigate(escapeTo)}
                      >
                        {escapeLabel}
                      </Button>
                    </Dialog.Cancel>
                    <Dialog.Action>
                      <Button
                        fullWidth
                        onClick={() => takeover()}
                      >
                        Take over editing here
                      </Button>
                    </Dialog.Action>
                  </>
                ) : (
                  <Dialog.Action>
                    <Button fullWidth onClick={() => navigate(escapeTo)}>
                      {escapeLabel}
                    </Button>
                  </Dialog.Action>
                )}
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Root>
        </Flex>
      ),
    };
  }

  if (mine) {
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
