// Acquisition, heartbeat and takeover for the record lock: owns the lock
// state machine and the polling lease lifecycle. Rendering lives in
// ./record-lock-panel; the response contract in ./record-lock-protocol.
import { getFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';
import { useLocation } from 'react-router-dom';

import { startPoll } from '../../utils/poll';
import {
  activateRecordLockLease,
  clearRecordLockLease,
  createLeaseId,
} from '../../utils/record-lock-lease';
import {
  ACQUIRE_TIMEOUT_MS,
  BLOCKED_RETRY_MS,
  HEARTBEAT_MS,
  RELEASE_CHANNEL,
  SINGLE_TYPE_CLIENT_KEY,
  parseAcquire,
  sameHolder,
  type AcquireResponse,
  type LockState,
  type ParsedAcquire,
} from './record-lock-protocol';

export function useRecordLock({
  model,
  documentId,
  collectionType,
}: {
  model: string;
  documentId?: string;
  collectionType?: string;
}) {
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
  return {
    state,
    lockable,
    isSingleType,
    currentKey,
    blocked,
    mine,
    readOnly,
    takeover: () => takeoverRef.current?.(),
  };
}
