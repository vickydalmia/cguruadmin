/**
 * Keeps a taxonomy entity's `isFestiveOffer` toggle and its two conditional
 * fields consistent. Applies to Store and Brand, which carry the same trio.
 *
 * The two fields are declared with `attributes.<field>.conditions.visible` in
 * both schemas, so the admin hides them whenever the toggle is off. Verified
 * against Strapi 5.50 (the same two halves coupon-type-consistency.ts documents
 * for `code` / `uniqueCouponPool`):
 *
 *   - Server: @strapi/core entity-validator evaluates `attr.conditions.visible`
 *     with json-logic and skips ALL validation for an invisible field.
 *   - Admin: @strapi/content-manager EditView `handleInvisibleAttributes` ->
 *     `filterDataByRemovedPaths` skips hidden paths, so they are OMITTED from
 *     the PUT body.
 *
 * Omitted is not cleared. Without this normaliser, an editor who fills in a
 * festive title, saves, then switches the toggle off leaves the old title and
 * description sitting in the database — invisible in the admin, but still
 * served by the API to anything that reads the fields without also checking
 * the toggle. Hiding stops the editor seeing them; this clears them.
 *
 * GRANDFATHERING / partial-payload safety
 * ---------------------------------------
 * Absence is never evidence of intent. If `isFestiveOffer` is not an own
 * property of the payload, this touches nothing — the same absolute rule
 * normaliseCouponTypeFields follows, and for the same reason: partial writes
 * (imports, scripted updates) that never mention the toggle must not wipe a
 * live festive offer as a side effect.
 *
 * Deliberately a normaliser, not a validator: it never throws, so it can never
 * strand an editor on a legacy row.
 */

const FESTIVE_OFFER_UIDS = ['api::store.store', 'api::brand.brand'] as const;

type FestiveOfferUid = (typeof FESTIVE_OFFER_UIDS)[number];

/** Fields the toggle owns, cleared together when it is off. */
export const FESTIVE_OFFER_FIELDS = [
  'festiveOfferTitle',
  'festiveOfferDescription',
] as const;

export const FESTIVE_OFFER_TITLE_MAX_LENGTH = 60;

export function isFestiveOfferUid(uid: unknown): uid is FestiveOfferUid {
  return FESTIVE_OFFER_UIDS.includes(uid as FestiveOfferUid);
}

/**
 * Clear the festive fields when the incoming payload turns the toggle off,
 * mutating `data` in place (same in-place contract as sanitizeRichtextData)
 * and returning it for convenience.
 *
 * NO-OPS, leaving the payload byte-identical, when:
 *   - `data` is not an object;
 *   - `isFestiveOffer` is absent from the payload;
 *   - `isFestiveOffer` is present and truthy — turning the toggle ON never
 *     clears anything, and the conditional fields arrive in the same payload.
 *
 * Explicitly INCLUDES `null`/`undefined`-valued toggles in the clearing case:
 * the schema default is `false`, so an unset toggle is not a festive offer and
 * must not keep festive content alive.
 */
export function normaliseFestiveOfferFields<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;

  // The load-bearing guard: is this write ABOUT the festive toggle at all?
  if (!Object.prototype.hasOwnProperty.call(data, 'isFestiveOffer')) return data;

  if (Reflect.get(data, 'isFestiveOffer') === true) return data;

  for (const field of FESTIVE_OFFER_FIELDS) {
    Reflect.set(data, field, null);
  }

  return data;
}
