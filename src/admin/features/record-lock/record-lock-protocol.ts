// The record-lock wire protocol: heartbeat cadence, the acquire response
// contract, and its defensive parser. Shared by the acquisition hook.

export const HEARTBEAT_MS = 20_000;
/** Faster cadence while blocked so the modal lifts promptly after the holder
 * leaves (their release lands immediately — see getFetchClient note below). */
export const BLOCKED_RETRY_MS = 10_000;
/** Abort a hung acquire well before the 90 s TTL: the next heartbeat is only
 * scheduled once the current one settles, so an un-aborted request stalled on
 * a dead connection would silently let the holder's lock lapse mid-edit.
 * Aborting is SAFE here — if the server commits the acquire after the abort,
 * the release's lease tombstone makes that late commit cancel itself (see the
 * record-lock service). */
export const ACQUIRE_TIMEOUT_MS = 15_000;
/** Same-browser tabs announce their releases here so a duplicate tab holding
 * the same entry re-acquires immediately instead of after ≤1 heartbeat. */
export const RELEASE_CHANNEL = 'record-lock-release';
/** Client-side stand-in key segment for single types (they have no
 * documentId prop). Never sent to the server — acquire/release simply OMIT
 * documentId and the record-lock service resolves the real pseudo id, so the
 * server stays the single owner of that mapping. */
export const SINGLE_TYPE_CLIENT_KEY = '@single-type';

export type Holder = { adminUserId: number; holderName: string; expiresAt: string };
export type AcquireResponse =
  | { acquired: true; expiresAt: string }
  | { acquired: false; holder: Holder; self?: boolean }
  | { acquired: false; cancelled: true };

export type LockState =
  | { phase: 'pending'; key: null }
  | { phase: 'mine'; key: string }
  | { phase: 'blocked'; key: string; holder: Holder; self: boolean };

export type ParsedAcquire =
  | { kind: 'mine' }
  | { kind: 'blocked'; holder: Holder; self: boolean }
  | { kind: 'cancelled' }
  | null;

/** The response passes through proxies and error pages that Strapi's fetch
 * client happily resolves as `{data:{}}` (empty 200, 204, non-JSON body).
 * Anything that is not a well-formed acquire result is a TRANSIENT failure to
 * retry — it must never become a blocked state with `holder: undefined`,
 * which would throw in render and take down the edit view. */
export const parseAcquire = (data: unknown): ParsedAcquire => {
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
export const sameHolder = (a: Holder, b: Holder) =>
  a.adminUserId === b.adminUserId && a.holderName === b.holderName;
