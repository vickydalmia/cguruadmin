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
import { useLocation, useNavigate } from 'react-router-dom';

import { startPoll } from '../utils/poll';
import {
  activateRecordLockLease,
  clearRecordLockLease,
  createLeaseId,
} from '../utils/record-lock-lease';

/**
 * "Edit lock" side panel — single-editor guard for every Content Manager edit
 * view. On mount it claims the lock for this entry (POST /record-lock/acquire,
 * admin router — see src/index.ts) and re-claims it every HEARTBEAT_MS so the
 * server-side 90 s TTL never lapses while the tab is open.
 *
 * When another admin already holds the lock the view is hard-blocked, three
 * layers deep:
 *   1. a modal that CANNOT be dismissed (no cancel, Esc and outside clicks
 *      are swallowed) — leaving for the list view is the only way out, plus
 *      "Take over" when the holder is another session of the SAME admin
 *      (e.g. the lease a page reload orphaned);
 *   2. the edit form is greyed out and made `inert` (unclickable, untypable,
 *      unfocusable) until this exact tab owns the lock;
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
/** Abort a hung acquire well before the 90 s TTL: the next heartbeat is only
 * scheduled once the current one settles, so an un-aborted request stalled on
 * a dead connection would silently let the holder's lock lapse mid-edit.
 * Aborting is SAFE here — if the server commits the acquire after the abort,
 * the release's lease tombstone makes that late commit cancel itself (see the
 * record-lock service). */
const ACQUIRE_TIMEOUT_MS = 15_000;
/** Same-browser tabs announce their releases here so a duplicate tab holding
 * the same entry re-acquires immediately instead of after ≤1 heartbeat. */
const RELEASE_CHANNEL = 'record-lock-release';
/** Client-side stand-in key segment for single types (they have no
 * documentId prop). Never sent to the server — acquire/release simply OMIT
 * documentId and the record-lock service resolves the real pseudo id, so the
 * server stays the single owner of that mapping. */
const SINGLE_TYPE_CLIENT_KEY = '@single-type';

type Holder = { adminUserId: number; holderName: string; expiresAt: string };
type AcquireResponse =
  | { acquired: true; expiresAt: string }
  | { acquired: false; holder: Holder; self?: boolean }
  | { acquired: false; cancelled: true };

type LockState =
  | { phase: 'pending'; key: null }
  | { phase: 'mine'; key: string }
  | { phase: 'blocked'; key: string; holder: Holder; self: boolean };

type ParsedAcquire =
  | { kind: 'mine' }
  | { kind: 'blocked'; holder: Holder; self: boolean }
  | { kind: 'cancelled' }
  | null;

/** The response passes through proxies and error pages that Strapi's fetch
 * client happily resolves as `{data:{}}` (empty 200, 204, non-JSON body).
 * Anything that is not a well-formed acquire result is a TRANSIENT failure to
 * retry — it must never become a blocked state with `holder: undefined`,
 * which would throw in render and take down the edit view. */
const parseAcquire = (data: unknown): ParsedAcquire => {
  const body = data as any;
  if (!body || typeof body !== 'object') return null;
  if (body.cancelled === true) return { kind: 'cancelled' };
  if (body.acquired === true) return { kind: 'mine' };
  if (
    body.acquired === false &&
    body.holder &&
    typeof body.holder.adminUserId === 'number' &&
    typeof body.holder.holderName === 'string'
  ) {
    return { kind: 'blocked', holder: body.holder, self: body.self === true };
  }
  return null;
};

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
  const { pathname } = useLocation();
  const [state, setState] = React.useState<LockState>({
    phase: 'pending',
    key: null,
  });
  const takeoverRef = React.useRef<(() => void) | null>(null);

  // The clone view reuses the edit route with the ORIGIN's documentId, but a
  // clone save is a `create` of a brand-new document — locking here would
  // block the clone form on the source entry's lock (or worse, hold the
  // source's lock and push its real editor into the blocked modal).
  const isCloneView = pathname.includes('/clone/');
  // Single types never get a documentId prop — the server locks them under
  // its own pseudo id when documentId is omitted; the client key below is
  // only for local state/broadcast identity. Collection-type entries being
  // CREATED have no documentId yet — nothing exists to lock until the first
  // save navigates to the created document's edit URL. Plugin content types
  // (upload folders, users-permissions…) are outside the lock API's scope.
  const isSingleType = collectionType === 'single-types';
  const lockDocumentId = isSingleType ? SINGLE_TYPE_CLIENT_KEY : documentId;
  const lockable =
    Boolean(lockDocumentId) && model.startsWith('api::') && !isCloneView;
  const currentKey = lockable ? `${model}:${lockDocumentId}` : null;

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
    const leaseId = createLeaseId();
    activateRecordLockLease(leaseId);

    const requestBody = (extra?: Record<string, unknown>) => ({
      model,
      // Single types omit documentId — the service owns the pseudo id.
      ...(isSingleType ? {} : { documentId: lockDocumentId }),
      leaseId,
      ...extra,
    });

    const applyResult = (parsed: Exclude<ParsedAcquire, null>) => {
      // Bail out (return prev) when nothing the panel renders has changed,
      // so steady-state heartbeats don't re-render the panel or the modal.
      setState((prev) => {
        if (parsed.kind === 'mine') {
          return prev.phase === 'mine' && prev.key === key
            ? prev
            : { phase: 'mine', key };
        }
        if (parsed.kind !== 'blocked') return prev;
        if (
          prev.phase === 'blocked' &&
          prev.key === key &&
          prev.self === parsed.self &&
          sameHolder(prev.holder, parsed.holder)
        ) {
          return prev;
        }
        return { phase: 'blocked', key, holder: parsed.holder, self: parsed.self };
      });
    };

    let lastBlocked = false;
    // Responses apply only if issued in the CURRENT epoch. The epoch bumps on
    // takeover (a blocked heartbeat already in flight would otherwise resolve
    // after the takeover succeeded and stomp the fresh 'mine' state back to
    // blocked, re-freezing the form) and on cleanup (a straggler from this
    // mount must not overwrite the next document's state).
    let epoch = 0;

    const poll = startPoll(async (alive) => {
      const issuedIn = epoch;
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        ACQUIRE_TIMEOUT_MS,
      );
      try {
        const { data } = await post<AcquireResponse>(
          '/record-lock/acquire',
          requestBody(),
          { signal: controller.signal },
        );
        if (!alive()) return null;
        if (issuedIn === epoch) {
          const parsed = parseAcquire(data);
          // A cancellation tombstone is created only by this panel's unmount
          // cleanup; observing one means this mount is already gone.
          if (parsed?.kind === 'cancelled') return null;
          if (parsed) {
            lastBlocked = parsed.kind === 'blocked';
            applyResult(parsed);
          }
          // Malformed body (proxy page, empty 204): fall through and retry —
          // keep the last known state, exactly like a network error.
        }
      } catch {
        // Timeout, network hiccup or server restart: keep the last known
        // state and retry on cadence. Saves stay guarded server-side.
      } finally {
        window.clearTimeout(timeout);
      }
      return lastBlocked ? BLOCKED_RETRY_MS : HEARTBEAT_MS;
    });

    // "Take over" for the same admin's orphaned session (page reload, tab the
    // browser killed): the server permits stealing ONLY the caller's own
    // lease-mates — another admin's lock is never stealable.
    takeoverRef.current = () => {
      epoch += 1; // outdate any heartbeat response still in flight
      const issuedIn = epoch;
      void post<AcquireResponse>(
        '/record-lock/acquire',
        requestBody({ takeover: true }),
      )
        .then(({ data }) => {
          if (issuedIn !== epoch) return;
          const parsed = parseAcquire(data);
          if (parsed && parsed.kind !== 'cancelled') {
            lastBlocked = parsed.kind === 'blocked';
            applyResult(parsed);
          }
        })
        .catch(() => undefined);
    };

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
      epoch += 1; // outdate every response still in flight from this mount
      poll.stop();
      channel?.close();
      takeoverRef.current = null;
      clearRecordLockLease(leaseId);
      // Release this TAB'S lease unconditionally (the server verifies both
      // admin user and leaseId, so this is a no-op when blocked). No need to
      // wait for an in-flight acquire: release records a lease tombstone
      // first, so an acquire that lands afterwards cancels itself instead of
      // resurrecting the row — the ordering is safe server-side.
      void post<{ released: boolean }>('/record-lock/release', requestBody())
        .then(({ data }) => {
          if (!data?.released) return;
          if (typeof BroadcastChannel !== 'undefined') {
            const announce = new BroadcastChannel(RELEASE_CHANNEL);
            announce.postMessage({ key });
            announce.close();
          }
        })
        .catch(() => undefined);
    };
  }, [lockable, model, lockDocumentId, isSingleType]);

  // Until this exact tab owns the lock, grey out and freeze the edit form.
  // `inert` removes the whole subtree from clicking, typing and tab order — a
  // true read-only view. This closes the pre-acquire window where a duplicate
  // same-user tab could submit before the modal appeared. Strapi re-renders
  // can swap the form node out from under us, so a MutationObserver re-applies
  // the freeze until ownership is confirmed; it watches document.body (not
  // <main>, which Strapi can also replace, orphaning the observer).
  const blocked = state.phase === 'blocked' && state.key === currentKey;
  const mine = state.phase === 'mine' && state.key === currentKey;
  const readOnly = lockable && !mine;
  React.useEffect(() => {
    if (!readOnly) return undefined;

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
  }, [readOnly]);

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
                        onClick={() => takeoverRef.current?.()}
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
