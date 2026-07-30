import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';

/**
 * Keeps an offer's `couponType` and its two type-specific fields consistent.
 * Applies to BOTH offer schemas — Coupon and Product Deal — which carry the
 * same pair of fields.
 *
 * An offer is either `static` (one shared `code`) or `unique` (codes handed out
 * from `uniqueCouponPool`). The two fields are mutually exclusive, but nothing
 * used to clear the losing one when an editor flipped the type — so an offer
 * switched from unique to static kept its pool attached and kept draining it.
 *
 * The offer schemas now hide the irrelevant field in the admin via
 * `attributes.<field>.conditions.visible` (json-logic, Strapi 5.50). Verified
 * against this exact version, both halves:
 *
 *   - Server: @strapi/core entity-validator/index.js `createAttributeValidator`
 *     evaluates `attr.conditions.visible` with json-logic and returns
 *     `yup.mixed().notRequired()` for an invisible field — all validation for
 *     it is skipped.
 *   - Admin: @strapi/content-manager EditView `handleInvisibleAttributes` ->
 *     `filterDataByRemovedPaths` `continue`s past a hidden path, so the field
 *     is OMITTED from the PUT body.
 *
 * Omitted is not the same as cleared: the stored column keeps its old value.
 * That is precisely why this normaliser exists — hiding the field stops the
 * editor seeing it, this clears it.
 *
 * GRANDFATHERING / cron safety
 * ----------------------------
 * The scheduling cron (config/cron-tasks.ts) issues
 * `update({ data: { contentStatus, ...maybe scheduledAt } })` — a PARTIAL
 * payload with no `couponType`. Deriving intent from such a payload would read
 * "couponType is not unique" and detach the pool from every scheduled unique
 * coupon the cron touches, every five minutes.
 *
 * So the rule is absolute: if `couponType` is not an own property of the
 * payload, touch nothing. Absence is never evidence of a type change.
 *
 * Note this is deliberately a normaliser, not a validator: it never throws and
 * never blocks a save, so it cannot strand an editor on a legacy row.
 */

/**
 * Both offer schemas carry `couponType` + `uniqueCouponPool`, so both need the
 * same normaliser and the same "unique needs a pool" check. The field name is
 * shared with Coupon deliberately: it describes the CODE variant, not the
 * entity, and keeping one name lets one implementation serve both.
 */
const OFFER_UIDS = ['api::coupon.coupon', 'api::deal.deal'] as const;
type OfferUid = (typeof OFFER_UIDS)[number];

/**
 * True for the content types this normaliser applies to. Exported so the
 * caller can guard without hard-coding the uid strings.
 */
export function isCouponUid(uid: unknown): uid is OfferUid {
  return OFFER_UIDS.includes(uid as OfferUid);
}

/**
 * Clear the field that the incoming `couponType` makes irrelevant, mutating
 * `data` in place (same in-place contract as `sanitizeRichtextData`) and
 * returning it for convenience.
 *
 *   couponType === 'static' -> `uniqueCouponPool` is cleared (null disconnects
 *                              the manyToOne relation)
 *   couponType === 'unique' -> `code` is cleared
 *
 * NO-OPS, leaving the payload byte-identical, when:
 *   - `data` is not an object;
 *   - `couponType` is absent from the payload (the cron's partial update, and
 *     any other partial write that does not concern the coupon type);
 *   - `couponType` is present but is not one of the two known enum members
 *     (null, undefined, '' or an unrecognised string) — an unreadable type is
 *     not a licence to delete a field.
 */
export function normaliseCouponTypeFields<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;

  // The load-bearing guard. `in`/hasOwnProperty rather than a truthiness check:
  // the question is whether this write is ABOUT the coupon type at all, not
  // what the type happens to be.
  if (!Object.prototype.hasOwnProperty.call(data, 'couponType')) return data;

  const couponType = Reflect.get(data, 'couponType');

  if (couponType === 'static') {
    Reflect.set(data, 'uniqueCouponPool', null);
  } else if (couponType === 'unique') {
    Reflect.set(data, 'code', null);
  }

  return data;
}

function directRelationPresent(value: unknown): boolean | null {
  if (value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.some((entry) => relationKeys(entry).length > 0);
  if (value && typeof value === 'object' && relationKeys(value).length > 0) {
    return true;
  }
  return null;
}

function resultingPoolPresent(
  incoming: unknown,
  current: RelationEntry | null,
): boolean {
  const direct = directRelationPresent(incoming);
  if (direct !== null) return direct;

  const resolved = resultingRelations(incoming, current ? [current] : []);
  return resolved === null ? Boolean(current) : resolved.length > 0;
}

/**
 * A unique offer cannot redeem without a pool. Static offers intentionally
 * may omit a shared code (the live UI then presents the offer without a copy
 * step). Existing unique offers that were already poolless are grandfathered
 * until their type/pool state is actually repaired or changed.
 *
 * STRICT ("clean as you touch"): `strict` is the last parameter and gates
 * full-record enforcement — true on a human admin save, false on the cron
 * (computed once by the caller via isHumanWrite; never computed here). When
 * strict, the type/pool consistency is enforced on the EFFECTIVE record
 * (payload merged over the stored row) even when the editor touched neither
 * couponType nor uniqueCouponPool, and the poolless-unique grandfather escape
 * is disabled — so a dirty legacy row blocks the save until it is repaired.
 * When strict is false, behaviour is UNCHANGED (the cron path).
 */
export async function validateCouponTypeFields(
  strapi: Core.Strapi,
  uid: OfferUid,
  action: string,
  data: unknown,
  documentId?: string,
  strict: boolean = false,
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const payload = data as Record<string, unknown>;
  const hasType = Object.prototype.hasOwnProperty.call(payload, 'couponType');
  const hasPool = Object.prototype.hasOwnProperty.call(payload, 'uniqueCouponPool');
  const isCreate = action === 'create';
  const isClone = action === 'clone';

  // STRICT validates the whole effective record, so it must not bail on a
  // payload that touches neither field — that is exactly the dirty untouched
  // case it exists to catch. The cron (strict === false) keeps bailing here.
  if (!strict && !isCreate && !isClone && !hasType && !hasPool) return;

  let stored: Record<string, unknown> | null = null;
  if ((action === 'update' || isClone) && documentId) {
    const found: unknown = await strapi
      .documents(uid as any)
      .findOne({
        documentId,
        fields: ['documentId', 'couponType'] as any,
        populate: {
          uniqueCouponPool: { fields: ['documentId'] },
        } as any,
      });
    if (found && typeof found === 'object') {
      stored = found as Record<string, unknown>;
    }
  }
  if (isClone && documentId && !stored) return;

  const storedType = stored?.couponType;
  const storedPool = (stored?.uniqueCouponPool ?? null) as RelationEntry | null;
  const couponType = hasType ? payload.couponType : storedType;
  const hasResultingPool = hasPool
    ? resultingPoolPresent(payload.uniqueCouponPool, storedPool)
    : Boolean(storedPool);

  if (couponType !== 'unique' || hasResultingPool) return;

  // A full Content Manager PUT re-sends null for an old poolless coupon. That
  // is the same invalid state, not a newly introduced defect, so do not strand
  // the editor on unrelated work — UNLESS strict, whose whole purpose is to
  // block the save on exactly this dirty legacy state until it is repaired.
  const wasAlreadyPoolless = storedType === 'unique' && !storedPool;
  if (!strict && action === 'update' && wasAlreadyPoolless) return;

  const message =
    'Choose a Unique Coupon Pool before saving a unique offer. Without a pool, ' +
    'the redeem action can never issue a code.';
  throw new errors.ValidationError(message, {
    errors: [
      {
        path: ['uniqueCouponPool'],
        message,
        name: 'ValidationError',
      },
    ],
    problems: [`uniqueCouponPool: ${message}`],
  });
}
