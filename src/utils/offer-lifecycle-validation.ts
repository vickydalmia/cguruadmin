import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { computeContentStatus, type ContentStatus } from './content-status';

/**
 * Offer lifecycle rules for coupon + deal (scheduledAt / expiresAt /
 * publishedOn / contentStatus). Run from the documents middleware on create +
 * update.
 *
 * STATE MACHINE — with S = scheduledAt, E = expiresAt, C = contentStatus,
 * N = now, C is DERIVED and never editor-chosen:
 *
 *   E <= N            -> expired
 *   else S >  N       -> scheduled
 *   else              -> published
 *
 * plus one normalisation: when C resolves to `published` and S <= N, S is
 * cleared to null. This mirrors the scheduler's own `shouldClearScheduledAt`
 * (config/cron-tasks.ts) so the validator and the cron can never disagree —
 * and it makes the (published, past S) pair unrepresentable, so no separate
 * guard for it is needed (nor wanted: it would fight the cron).
 *
 * PUBLISHED-ON (P) is the editor-controlled sort key behind every "newest
 * first" listing (src/utils/offer-visibility.ts). It is deliberately NOT part
 * of the state machine: re-dating an offer resurfaces it, it never revives an
 * expired one. P is seeded to N the moment the offer first becomes live —
 * here on a create that resolves to `published`, or by the scheduler when a
 * `scheduled` offer goes live — so a scheduled offer surfaces as new on its
 * go-live date rather than its authoring date.
 *
 * ENTRY GUARDS (rejected with an inline field error) — all change-detected,
 * i.e. they only fire when the incoming payload actually WRITES the field:
 *   1. S in the past
 *   2. E in the past
 *   3. S >= E when both are set
 *   4. P in the future (it would pin the offer to the top of every listing
 *      until that date passed)
 *
 * GRANDFATHERING (strict === false): this lands on a populated production DB
 * with no pre-flight cleanup. A legacy row that already violates a guard stays
 * saveable — an editor who does not touch S/E is never blocked by them, even
 * when the stored values are invalid. Only the derived C (and the S
 * normalisation) is applied to such a row, which repairs it rather than
 * blocking it. Creates are validated in full. This is the CRON path.
 *
 * STRICT ("clean as you touch", strict === true): a human admin save. EVERY
 * guard is enforced against the EFFECTIVE dates (payload merged over the stored
 * row), even on fields the editor did not touch — so a dirty legacy S/E blocks
 * the save until the record is clean. Reuses the same merge the clone path
 * already builds; the caller passes `strict` (computed once via isHumanWrite),
 * this function never computes it. The derived C and S normalisation are
 * UNCHANGED in either mode (the cron depends on them).
 *
 * THE PARTIAL-PAYLOAD TRAP: `context.params.data` is PARTIAL on update. The
 * 5-minute scheduler issues `update({ data: { contentStatus: 'expired' } })`
 * with no dates at all. Deriving C from the payload alone would yield
 * `published` for every one of those rows, flipping expired offers back live
 * every five minutes forever and enqueueing a rebuild each time. So C is
 * ALWAYS derived from the payload MERGED OVER THE STORED ROW.
 */

export const OFFER_LIFECYCLE_UIDS = [
  'api::coupon.coupon',
  'api::deal.deal',
] as const;

export type OfferLifecycleUid = (typeof OFFER_LIFECYCLE_UIDS)[number];

export function isOfferLifecycleUid(uid: string): uid is OfferLifecycleUid {
  return OFFER_LIFECYCLE_UIDS.includes(uid as OfferLifecycleUid);
}

/**
 * Slack between "the editor picked a time" and "the save reached the server".
 * A datetime picked at minute granularity and saved a moment later is read as
 * "now", not as a past-dated mistake: it passes the guards and the state
 * machine resolves it (published + S cleared, or expired). Anything further
 * back than this is a genuine mistake worth rejecting.
 */
export const LIFECYCLE_WRITE_GRACE_MS = 60_000;

type Problem = { path: string[]; message: string };

function toTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  if (!date) return null;
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

const iso = (time: number): string => new Date(time).toISOString();

const hasField = (data: object, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(data, field);

/**
 * Validate + normalise the lifecycle fields of a coupon/deal payload.
 *
 * Mutates `data`: sets `contentStatus` to the derived value and clears
 * `scheduledAt` when the normalisation applies (same mutate-the-payload
 * contract as `sanitizeRichtextData`). Throws `errors.ValidationError` with
 * `details.errors[].path` string arrays so the admin renders an inline error
 * on the offending field instead of an unmappable 500.
 *
 * `strict` gates full-record enforcement (true = human admin save, false =
 * cron / grandfathered). It is the last real parameter; `now` after it is
 * injectable for tests only — production callers pass six arguments.
 */
export async function validateOfferLifecycle(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
  documentId?: string,
  strict: boolean = false,
  now: Date = new Date(),
): Promise<void> {
  if (!isOfferLifecycleUid(uid)) return;
  if (!data || typeof data !== 'object') return;

  const payload = data as Record<string, unknown>;
  const isFreshCreate = action === 'create' || !documentId;

  // On update/clone the stored row is the merge base. Strapi applies a clone's
  // partial `data` over this source only after document middleware runs.
  // Without it nothing can
  // be derived safely, so bail out entirely rather than derive from the
  // partial payload (see THE PARTIAL-PAYLOAD TRAP above).
  let stored: Record<string, unknown> | null = null;
  if (!isFreshCreate && documentId) {
    const found: unknown = await strapi.documents(uid).findOne({
      documentId,
      fields: ['documentId', 'scheduledAt', 'expiresAt', 'publishedOn'],
    });
    if (!found || typeof found !== 'object') return;
    stored = found as Record<string, unknown>;
  }

  const storedScheduledAt = stored ? stored.scheduledAt : undefined;
  const storedExpiresAt = stored ? stored.expiresAt : undefined;
  const storedPublishedOn = stored ? stored.publishedOn : undefined;

  const scheduledSent = hasField(payload, 'scheduledAt');
  const expiresSent = hasField(payload, 'expiresAt');
  const publishedOnSent = hasField(payload, 'publishedOn');

  // Payload merged over the stored row — the only safe input to the state
  // machine, and to the guards.
  const mergedScheduledAt = scheduledSent ? payload.scheduledAt : storedScheduledAt;
  const mergedExpiresAt = expiresSent ? payload.expiresAt : storedExpiresAt;
  const mergedPublishedOn = publishedOnSent ? payload.publishedOn : storedPublishedOn;

  const scheduledMs = toTime(mergedScheduledAt);
  const expiresMs = toTime(mergedExpiresAt);
  const publishedOnMs = toTime(mergedPublishedOn);
  const nowMs = now.getTime();
  const floorMs = nowMs - LIFECYCLE_WRITE_GRACE_MS;
  // Mirror of floorMs for the future-facing guard: a date picked "now" and
  // saved a moment later must not read as future-dated.
  const ceilingMs = nowMs + LIFECYCLE_WRITE_GRACE_MS;

  // Change detection. The admin edit view posts the WHOLE form back, so field
  // presence alone means nothing — a legacy row would trip its own stored
  // values on every save. Compare instants instead, so a re-sent value (and an
  // ISO string vs a stored Date) counts as untouched.
  //
  // STRICT: treat every field as touched, so the guards run against the
  // effective (merged) dates regardless of change — this is what blocks a save
  // on a dirty untouched S/E. On a create every field is validated anyway.
  const scheduledChanged =
    strict || isFreshCreate
      ? true
      : scheduledSent && toTime(payload.scheduledAt) !== toTime(storedScheduledAt);
  const expiresChanged =
    strict || isFreshCreate
      ? true
      : expiresSent && toTime(payload.expiresAt) !== toTime(storedExpiresAt);
  const publishedOnChanged =
    strict || isFreshCreate
      ? true
      : publishedOnSent && toTime(payload.publishedOn) !== toTime(storedPublishedOn);

  const problems: Problem[] = [];

  if (scheduledChanged && scheduledMs !== null && scheduledMs < floorMs) {
    problems.push({
      path: ['scheduledAt'],
      message:
        `Scheduled at must be in the future — ${iso(scheduledMs)} has already passed. ` +
        'Pick a later date, or clear the field to publish immediately.',
    });
  }

  if (expiresChanged && expiresMs !== null && expiresMs < floorMs) {
    problems.push({
      path: ['expiresAt'],
      message:
        `Expires at must be in the future — ${iso(expiresMs)} has already passed. ` +
        'Pick a later date, or clear the field to keep this offer live.',
    });
  }

  if (publishedOnChanged && publishedOnMs !== null && publishedOnMs > ceilingMs) {
    problems.push({
      path: ['publishedOn'],
      message:
        `Published date must not be in the future — ${iso(publishedOnMs)} has not ` +
        'arrived yet. Use Scheduled at to hold an offer back; Published date only ' +
        'controls where it sits in "newest first" listings.',
    });
  }

  if (
    (scheduledChanged || expiresChanged) &&
    scheduledMs !== null &&
    expiresMs !== null &&
    scheduledMs >= expiresMs
  ) {
    problems.push({
      path: [scheduledChanged ? 'scheduledAt' : 'expiresAt'],
      message:
        `Scheduled at (${iso(scheduledMs)}) must be earlier than Expires at ` +
        `(${iso(expiresMs)}) — this offer would expire before it went live.`,
    });
  }

  if (problems.length) {
    const noun = problems.length === 1 ? 'problem' : 'problems';
    throw new errors.ValidationError(
      `Offer schedule check failed (${problems.length} ${noun} — the fields are ` +
        `highlighted in the form):\n• ${problems
          .map((p) => `${p.path.join('.')}: ${p.message}`)
          .join('\n• ')}`,
      {
        // The admin edit view turns details.errors[].path into an inline error
        // on that exact field.
        errors: problems.map((p) => ({
          path: p.path,
          message: p.message,
          name: 'ValidationError',
        })),
        problems: problems.map((p) => `${p.path.join('.')}: ${p.message}`),
      },
    );
  }

  const status: ContentStatus = computeContentStatus({
    scheduledAt: mergedScheduledAt as Date | string | null | undefined,
    expiresAt: mergedExpiresAt as Date | string | null | undefined,
    now,
  });
  payload.contentStatus = status;

  // Normalisation — identical to the scheduler's shouldClearScheduledAt.
  if (status === 'published' && scheduledMs !== null && scheduledMs <= nowMs) {
    payload.scheduledAt = null;
  }

  // Seed the sort key the first time an offer is live. A create that resolves
  // to `published` is live right now; a `scheduled` one is not, so it is left
  // null for the scheduler to stamp at go-live (config/cron-tasks.ts). Never
  // overwrites an existing value — that is the editor's to control.
  if (status === 'published' && publishedOnMs === null) {
    payload.publishedOn = new Date(nowMs).toISOString();
  } else if (
    publishedOnSent &&
    publishedOnMs !== null &&
    publishedOnMs > nowMs &&
    publishedOnMs <= ceilingMs
  ) {
    // "Now" per the CLIENT is not "now" per the server. The "Bump to top"
    // action and the datetime picker both send a browser-generated instant, so
    // a slightly fast client clock would otherwise store a future sort key —
    // and two offers bumped seconds apart would order by whose machine was
    // further ahead, not by who clicked last. Anything inside the grace window
    // means "now", so store the server's now; beyond it the guard above has
    // already rejected the value.
    payload.publishedOn = new Date(nowMs).toISOString();
  }
}
