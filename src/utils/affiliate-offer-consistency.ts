import type { Core } from '@strapi/strapi';

import {
  AFFILIATE_OFFER_TOGGLE_FIELD,
  AFFILIATE_OFFER_UIDS,
  BRAND_AFFILIATE_FLAG_FIELD,
  type AffiliateOfferUid,
} from '../constants/affiliate-offer';
import {
  CHECKOUT_MERCHANT_FIELD,
  isBlankCheckoutMerchant,
} from '../constants/checkout-merchant';
import { normalizeRelationShorthand } from './content-manager-offer-store-validation';
import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { isContentManagerWrite } from './write-origin';
import { toValidationError, type Problem } from './write-validation/problems';

/**
 * Keeps an offer's `isForAffiliateBrand` toggle and the fields it excludes
 * consistent. An affiliate-brand offer belongs to affiliate Brands only: no
 * Stores, no Logo Store, no Checkout merchant, and every selected Brand must
 * carry `isAffiliateStore`.
 *
 * Same two-halves shape as festive-offer-consistency.ts, with the clearing
 * direction INVERTED: `logoStore`/`checkoutMerchant` are visible-when-OFF
 * (`conditions.visible: != true` in both offer schemas), so the toggle owns
 * them when it is ON. The admin OMITS hidden fields from the PUT body, which
 * makes the normaliser here the only place they actually get cleared.
 *
 * The validator is Content-Manager-gated like the at-most-one-Store rule and
 * re-reads stored relations on update/clone for the same reason: a legacy or
 * programmatically-dirtied row must stop and ask the editor to clean it up.
 * A concurrent Brand un-flag can race an offer save (no advisory lock —
 * deliberate, the invariant is per-document); the strict re-check on the
 * offer's next admin save self-heals whatever slips through.
 */

const BRAND_UID = 'api::brand.brand';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Fields the toggle owns, cleared together when it turns ON. */
export const AFFILIATE_OFFER_CLEARED_FIELDS = [
  'logoStore',
  CHECKOUT_MERCHANT_FIELD,
] as const;

/**
 * Clear the excluded fields when the incoming payload turns the toggle ON,
 * mutating `data` in place (same contract as normaliseFestiveOfferFields).
 *
 * NO-OPS, leaving the payload byte-identical, when:
 *   - `data` is not an object;
 *   - `isForAffiliateBrand` is absent from the payload — absence is never
 *     evidence of intent; partial writes (imports, crons) that never mention
 *     the toggle must not wipe a live offer's Logo Store as a side effect;
 *   - the toggle is present but not `true` — OFF owns nothing, and legacy
 *     rows hold NULL (no DB column default), which must read as OFF.
 */
export function normaliseAffiliateOfferFields<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;

  if (!hasOwn(data, AFFILIATE_OFFER_TOGGLE_FIELD)) return data;

  if (Reflect.get(data, AFFILIATE_OFFER_TOGGLE_FIELD) !== true) return data;

  for (const field of AFFILIATE_OFFER_CLEARED_FIELDS) {
    Reflect.set(data, field, null);
  }

  return data;
}

/** id/documentId split for a brand lookup, same shape as dealRelationWhere. */
function brandLookupWhere(
  relations: readonly RelationEntry[],
): Record<string, unknown> | null {
  const ids = new Set<string | number>();
  const documentIds = new Set<string>();

  for (const relation of relations) {
    if (typeof relation === 'number') {
      ids.add(relation);
      continue;
    }
    if (typeof relation === 'string') {
      documentIds.add(relation);
      continue;
    }
    if (!relation || typeof relation !== 'object') continue;
    const id = relation.id;
    const documentId = relation.documentId;
    if (typeof id === 'string' || typeof id === 'number') ids.add(id);
    if (typeof documentId === 'string') documentIds.add(documentId);
  }

  const clauses: Record<string, unknown>[] = [];
  if (ids.size) clauses.push({ id: { $in: [...ids] } });
  if (documentIds.size) {
    clauses.push({ documentId: { $in: [...documentIds] } });
  }
  return clauses.length ? { $or: clauses } : null;
}

/**
 * Names of the selected Brands that are NOT affiliate stores. An entry that
 * matches no Brand row is reported by its reference key — the connect would
 * fail later anyway, but silently passing it here would read as "affiliate".
 */
async function nonAffiliateBrandNames(
  strapi: Core.Strapi,
  entries: readonly RelationEntry[],
): Promise<string[]> {
  const where = brandLookupWhere(entries);
  if (!where) return [];

  const rows: Record<string, unknown>[] = await strapi.db
    .query(BRAND_UID)
    .findMany({
      where,
      select: ['id', 'documentId', 'name', BRAND_AFFILIATE_FLAG_FIELD],
    });

  const offenders: string[] = [];
  for (const entry of entries) {
    const keys = new Set(relationKeys(entry));
    if (!keys.size) continue;

    const row = rows.find((candidate) =>
      [candidate?.documentId, candidate?.id]
        .filter((key) => key !== undefined && key !== null)
        .some((key) => keys.has(String(key))),
    );

    if (!row) {
      offenders.push([...keys][0]);
      continue;
    }
    if (Reflect.get(row, BRAND_AFFILIATE_FLAG_FIELD) !== true) {
      const name = row.name;
      offenders.push(
        typeof name === 'string' && name
          ? name
          : String(row.documentId ?? row.id),
      );
    }
  }
  return offenders;
}

/**
 * Enforces the affiliate-offer invariant for Content-Manager writes: toggle ON
 * means zero Stores, only affiliate Brands, and no payload-explicit Logo
 * Store / Checkout merchant. Non-CM writes are fully exempt — imports and
 * crons keep working untouched, and a row they dirty is caught (stores/brands)
 * or cleared (logoStore/checkoutMerchant, via the Group A normaliser) on the
 * row's next admin save.
 *
 * `logoStore`/`checkoutMerchant` are only judged when the PAYLOAD sets them:
 * the editor cannot see a hidden field, so rejecting stored dirt here would
 * strand them on a row they cannot fix from the form.
 */
export async function validateAffiliateOfferForWrite(
  strapi: Core.Strapi,
  uid: AffiliateOfferUid,
  action: string,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (
    !['create', 'update', 'clone'].includes(action) ||
    !isContentManagerWrite(strapi)
  ) {
    return;
  }

  const payload: Record<string, unknown> =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};

  let stored: Record<string, unknown> | null = null;
  if ((action === 'update' || action === 'clone') && documentId) {
    const current: unknown = await strapi.documents(uid).findOne({
      documentId,
      fields: ['documentId', AFFILIATE_OFFER_TOGGLE_FIELD],
      populate: {
        stores: { fields: ['documentId'] },
        brands: { fields: ['documentId', 'name', BRAND_AFFILIATE_FLAG_FIELD] },
      },
    });
    stored =
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)
        : null;
  }

  const toggleOn = hasOwn(payload, AFFILIATE_OFFER_TOGGLE_FIELD)
    ? payload[AFFILIATE_OFFER_TOGGLE_FIELD] === true
    : stored?.[AFFILIATE_OFFER_TOGGLE_FIELD] === true;
  if (!toggleOn) return;

  const storedRelations = (field: string): RelationEntry[] => {
    const value = stored?.[field];
    return Array.isArray(value) ? value : [];
  };
  const resolveResulting = (field: string): RelationEntry[] => {
    const current = storedRelations(field);
    if (!hasOwn(payload, field)) return current;
    return (
      resultingRelations(normalizeRelationShorthand(payload[field]), current) ??
      current
    );
  };

  const problems: Problem[] = [];

  const stores = resolveResulting('stores');
  if (stores.length > 0) {
    problems.push({
      path: ['stores'],
      message:
        `An affiliate-brand offer cannot have Stores. Remove ` +
        `${stores.length === 1 ? 'the Store' : `all ${stores.length} Stores`}` +
        `, or turn the Affiliate brand toggle off.`,
    });
  }

  const brands = resolveResulting('brands');
  if (brands.length > 0) {
    const offenders = await nonAffiliateBrandNames(strapi, brands);
    if (offenders.length > 0) {
      problems.push({
        path: ['brands'],
        message:
          `Only affiliate Brands can be selected on an affiliate-brand ` +
          `offer. Not marked "Affiliate Store": ${offenders.join(', ')}.`,
      });
    }
  }

  if (hasOwn(payload, 'logoStore')) {
    const resolved =
      resultingRelations(normalizeRelationShorthand(payload.logoStore), []) ??
      [];
    if (resolved.length > 0) {
      problems.push({
        path: ['logoStore'],
        message:
          'An affiliate-brand offer cannot have a Logo Store. It is cleared ' +
          'automatically while the toggle is on.',
      });
    }
  }

  if (
    hasOwn(payload, CHECKOUT_MERCHANT_FIELD) &&
    !isBlankCheckoutMerchant(payload[CHECKOUT_MERCHANT_FIELD])
  ) {
    problems.push({
      path: [CHECKOUT_MERCHANT_FIELD],
      message:
        'An affiliate-brand offer cannot have a Checkout merchant. It is ' +
        'cleared automatically while the toggle is on.',
    });
  }

  if (problems.length > 0) throw toValidationError(problems);
}

/**
 * Blocks un-flagging a Brand (`isAffiliateStore` ON → OFF) while affiliate
 * offers still reference it — otherwise one Brand edit silently makes every
 * such offer un-saveable with no hint why.
 *
 * NOT Content-Manager-gated: any write path that explicitly sends the flag is
 * held to the invariant, and one that never mentions it is intrinsically
 * untouched (same absence-is-not-intent rule as the normalisers). Cost is one
 * stored-flag read on flag-carrying updates — the counts only run on a real
 * ON → OFF flip.
 */
export async function validateAffiliateBrandFlip(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (uid !== BRAND_UID || action !== 'update' || !documentId) return;
  if (!data || typeof data !== 'object') return;
  if (!hasOwn(data, BRAND_AFFILIATE_FLAG_FIELD)) return;
  if (Reflect.get(data, BRAND_AFFILIATE_FLAG_FIELD) === true) return;

  const stored: unknown = await strapi.documents(BRAND_UID).findOne({
    documentId,
    fields: ['documentId', BRAND_AFFILIATE_FLAG_FIELD],
  });
  const storedFlag =
    stored && typeof stored === 'object'
      ? Reflect.get(stored, BRAND_AFFILIATE_FLAG_FIELD)
      : undefined;
  if (storedFlag !== true) return;

  const counts = await Promise.all(
    AFFILIATE_OFFER_UIDS.map((offerUid) =>
      strapi.documents(offerUid).count({
        filters: {
          isForAffiliateBrand: true,
          brands: { documentId: { $eq: documentId } },
        },
      }),
    ),
  );
  const total = counts.reduce((sum, count) => sum + (count ?? 0), 0);
  if (total === 0) return;

  const reference = total === 1 ? 'offer still references' : 'offers still reference';
  throw toValidationError([
    {
      path: [BRAND_AFFILIATE_FLAG_FIELD],
      message:
        `${total} affiliate ${reference} this Brand. Remove it from those ` +
        `Coupons/Product Deals (or turn their Affiliate brand toggle off) ` +
        `before un-marking it as an affiliate store.`,
    },
  ]);
}
