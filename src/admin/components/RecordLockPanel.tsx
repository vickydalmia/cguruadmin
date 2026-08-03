import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { getFetchClient } from '@strapi/strapi/admin';
import {
  Button,
  Dialog,
  Flex,
  Status,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { SINGLE_TYPE_LOCK_DOCUMENT_ID } from '../../constants/record-lock';
import { startPoll } from '../utils/poll';

/**
 * "Edit lock" side panel — single-editor guard for every Content Manager edit
 * view. On mount it claims the lock for this entry (POST /record-lock/acquire,
 * admin router — see src/index.ts) and re-claims it every HEARTBEAT_MS so the
 * server-side 90 s TTL never lapses while the tab is open.
 *
 * When another admin already holds the lock the view is hard-blocked, three
 * layers deep:
 *   1. a modal that CANNOT be dismissed (no cancel, Esc and outside clicks
 *      are swallowed) — leaving for the list view is the only button;
 *   2. the edit form is greyed out and made `inert` (unclickable, untypable,
 *      unfocusable) in case the modal is ever bypassed;
 *   3. the server rejects the save anyway (document middleware in
 *      src/index.ts) — the DOM layers are UX, the middleware is the guarantee.
 * The same heartbeat keeps retrying while blocked — the moment the holder
 * leaves (or their lock expires) the modal closes and the form re-enables
 * automatically.
 */

const HEARTBEAT_MS = 20_000;
/** Faster cadence while blocked so the modal lifts promptly after the holder
 * leaves (their release lands immediately — see getFetchClient note below). */
const BLOCKED_RETRY_MS = 10_000;
/** Abort a hung acquire well before the 90 s TTL. The next heartbeat is only
 * scheduled once the current one settles, so without this a request stalled
 * on a dead connection would silently let the holder's lock lapse mid-edit. */
const ACQUIRE_TIMEOUT_MS = 15_000;
/** Same-browser tabs announce their releases here so a duplicate tab holding
 * the same entry re-acquires immediately instead of after ≤1 heartbeat. */
const RELEASE_CHANNEL = 'record-lock-release';

type Holder = { adminUserId: number; holderName: string; expiresAt: string };
type AcquireResponse =
  | { acquired: true; expiresAt: string }
  | { acquired: false; holder: Holder };

type LockState =
  | { phase: 'pending' }
  | { phase: 'mine' }
  | { phase: 'blocked'; holder: Holder };

/** Identity for render purposes — expiresAt moves on every holder heartbeat
 * and is not displayed, so it must not force re-renders. */
const sameHolder = (a: Holder, b: Holder) =>
  a.adminUserId === b.adminUserId && a.holderName === b.holderName;

/** The CM edit form (fields + Save/Publish panel). `:not([role="search"])`
 * keeps any header search form out of the match. */
const findEditForm = (): HTMLFormElement | null =>
  document.querySelector<HTMLFormElement>('main form:not([role="search"])');

const RecordLockPanel: PanelComponent = ({
  model,
  documentId,
  collectionType,
}) => {
  const navigate = useNavigate();
  const [state, setState] = React.useState<LockState>({ phase: 'pending' });

  // Single types never get a documentId prop — their one document is locked
  // under a fixed pseudo id instead (the service normalizes to the same id).
  // Collection-type entries being CREATED have no documentId yet — nothing
  // exists to lock until the first save navigates to the created document's
  // edit URL. Plugin content types (upload folders, users-permissions…) are
  // outside the lock API's api:: scope.
  const isSingleType = collectionType === 'single-types';
  const lockDocumentId = isSingleType
    ? SINGLE_TYPE_LOCK_DOCUMENT_ID
    : documentId;
  const lockable = Boolean(lockDocumentId) && model.startsWith('api::');

  React.useEffect(() => {
    if (!lockable || !lockDocumentId) return undefined;

    // getFetchClient, NOT the useFetchClient hook: the hook's client aborts
    // its in-flight requests when the component unmounts — which is exactly
    // when the release below fires. With the hook, the release never reached
    // the server and the next editor sat behind the modal for the full 90 s
    // TTL after this one had already left.
    const { post } = getFetchClient();
    const key = `${model}:${lockDocumentId}`;
    // Every mounted edit view owns a distinct server lease. A duplicate tab
    // from the same admin must not be able to refresh or release this tab's
    // lock merely because both requests share the same adminUserId.
    const leaseId = window.crypto.randomUUID();

    // The most recent acquire attempt, settled or not. The unmount release
    // must run strictly AFTER it: a release processed while the first
    // acquire is still in flight lands before it, and the acquire then
    // resurrects the just-released row as an orphan nobody heartbeats —
    // exactly the open-and-back-out-within-a-second phantom lock.
    let inFlight: Promise<unknown> = Promise.resolve();

    const poll = startPoll(async (alive) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        ACQUIRE_TIMEOUT_MS,
      );
      const request = post<AcquireResponse>(
        '/record-lock/acquire',
        { model, documentId: lockDocumentId, leaseId },
        { signal: controller.signal },
      );
      inFlight = request.catch(() => undefined);
      let blocked = false;
      try {
        const { data } = await request;
        if (!alive()) return null;
        blocked = !data.acquired;
        // Bail out (return prev) when nothing the panel renders has changed,
        // so steady-state heartbeats don't re-render the panel or the modal.
        setState((prev) => {
          if (data.acquired) {
            return prev.phase === 'mine' ? prev : { phase: 'mine' };
          }
          if (
            prev.phase === 'blocked' &&
            sameHolder(prev.holder, data.holder)
          ) {
            return prev;
          }
          return { phase: 'blocked', holder: data.holder };
        });
      } catch {
        // Timeout, network hiccup or server restart: keep the last known
        // state and retry on cadence. Saves stay guarded server-side.
      } finally {
        window.clearTimeout(timeout);
      }
      return blocked ? BLOCKED_RETRY_MS : HEARTBEAT_MS;
    });

    // A duplicate tab is blocked by this tab's lease just like any other
    // editor. When the owning tab releases, retry NOW so the duplicate does
    // not wait for its next blocked heartbeat.
    const channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(RELEASE_CHANNEL)
        : null;
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        if (event.data?.key === key) poll.kick();
      };
    }

    return () => {
      poll.stop();
      channel?.close();
      // Release this TAB'S lease unconditionally (the server verifies both
      // admin user and leaseId, so this is a no-op when blocked). A mount
      // abandoned during its first acquire may still have created a lock.
      // Chaining after inFlight prevents that acquire from resurrecting an
      // orphan after its release has already run.
      void inFlight.then(() =>
        post<{ released: boolean }>('/record-lock/release', {
          model,
          documentId: lockDocumentId,
          leaseId,
        })
          .then(({ data }) => {
            if (!data.released) return;
            if (typeof BroadcastChannel !== 'undefined') {
              const announce = new BroadcastChannel(RELEASE_CHANNEL);
              announce.postMessage({ key });
              announce.close();
            }
          })
          .catch(() => undefined),
      );
    };
  }, [lockable, model, lockDocumentId]);

  // While blocked, grey out and freeze the edit form. `inert` removes the
  // whole subtree from clicking, typing and tab order — a true read-only
  // view. Strapi re-renders can swap the form node out from under us, so a
  // MutationObserver re-applies the freeze until the block lifts; it watches
  // document.body (not <main>, which Strapi can also replace, orphaning the
  // observer) and cleanup re-queries rather than closing over a stale node.
  const blocked = state.phase === 'blocked';
  React.useEffect(() => {
    if (!blocked) return undefined;

    const freeze = () => {
      const form = findEditForm();
      if (form && !form.hasAttribute('inert')) {
        form.setAttribute('inert', '');
        form.style.opacity = '0.5';
      }
    };
    freeze();

    const observer = new MutationObserver(freeze);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      const form = findEditForm();
      if (form) {
        form.removeAttribute('inert');
        form.style.opacity = '';
      }
    };
  }, [blocked]);

  if (!lockable) return null;

  if (state.phase === 'blocked') {
    const { holder } = state;
    // history.go(-1) is a no-op in a fresh tab (cmd-click, pasted URL), which
    // would strand the editor behind a modal with a dead button — so leave to
    // an explicit destination instead. Single types have no list view; the
    // Content Manager home is the nearest safe landing.
    const escapeTo = isSingleType
      ? '/content-manager'
      : `/content-manager/collection-types/${model}`;
    return {
      title: 'Edit lock',
      content: (
        <Flex direction="column" alignItems="stretch" gap={2}>
          <Status variant="danger" size="S">
            <Typography>
              <Typography fontWeight="bold">{holder.holderName}</Typography>
              {' is editing this entry right now — come back later.'}
            </Typography>
          </Status>
          {/* Deliberately NOT dismissible: open is pinned to the blocked
              state, so Esc / outside clicks are ignored and there is no
              cancel button. It closes only when the holder finishes (the
              heartbeat flips the state) or the editor leaves. */}
          <Dialog.Root open onOpenChange={() => undefined}>
            <Dialog.Content>
              <Dialog.Header>Entry is being edited</Dialog.Header>
              <Dialog.Body>
                {`${holder.holderName} is currently working on this entry. ` +
                  'Editing is locked so their changes are not overwritten — ' +
                  'please come back later. This screen unlocks by itself ' +
                  'the moment they finish.'}
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.Action>
                  <Button fullWidth onClick={() => navigate(escapeTo)}>
                    {isSingleType ? 'Back to Content Manager' : 'Back to list'}
                  </Button>
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
