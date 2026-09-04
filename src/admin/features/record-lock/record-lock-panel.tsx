import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { Flex, Status, Typography } from '@strapi/design-system';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { EditorLockOverlay } from './editor-lock-overlay';
import { useReadOnlyEditForm } from './read-only-form';
import { useRecordLock } from './use-record-lock';

/**
 * "Edit lock" side panel — single-editor guard for every Content Manager edit
 * view. On mount it claims the lock for this entry (POST /record-lock/acquire,
 * admin router — see src/register/admin-routes.ts) and re-claims it every HEARTBEAT_MS so the
 * server-side 90 s TTL never lapses while the tab is open.
 *
 * When another admin already holds the lock the editor workspace is covered
 * by a scoped modal, while Content Manager navigation remains available.
 * Enforcement is three
 * layers deep (acquisition/heartbeat/takeover: ./use-record-lock;
 * response contract: ./record-lock-protocol; form freeze: ./read-only-form):
 *   1. a modal constrained to <main> explains who owns the entry and offers
 *      "Take over" when the holder is another session of the SAME admin;
 *   2. the complete edit form is greyed out and made `inert` until this exact
 *      tab owns the lock, without touching either navigation sidebar;
 *   3. the server rejects the save anyway (document middleware in
 *      src/register/record-lock-document.ts) — the DOM layers are UX, the
 *      middleware is the guarantee.
 * The same heartbeat keeps retrying while blocked — the moment the holder
 * leaves (or their lock expires) the form re-enables automatically.
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
    // Single types have no list view; the Content Manager home is the nearest
    // explicit destination. Global and Content Manager navigation remain live.
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
          <EditorLockOverlay
            self={self}
            holderName={holder.holderName}
            escapeLabel={escapeLabel}
            onEscape={() => navigate(escapeTo)}
            onTakeover={() => takeover()}
          />
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
