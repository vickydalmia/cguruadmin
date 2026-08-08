import type { Core } from '@strapi/strapi';

import {
  CHECKOUT_MERCHANT_FIELD,
  parseCheckoutMerchant,
} from '../constants/checkout-merchant';
import {
  normalizeRelationShorthand,
  OFFER_STORE_UIDS,
  type OfferStoreUid,
} from './content-manager-offer-store-validation';
import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { toValidationError, type Problem } from './write-validation/problems';

/**
 * Affiliate brands are an offer's ONLY merchant.
 *
 * A Brand with `isAffiliate: true` may never share a Coupon or Product Deal
 * with a Store, another brand (affiliate or not), or a `checkoutMerchant`
 * pointing anywhere but at itself. Two halves, mirroring the
 * checkout-merchant-validation.ts split:
 *
 *   1. validateOfferAffiliateBrands — rejects any offer write whose FINAL
 *      state would violate the rule. Runs for every documents-service write
 *      (admin, REST, imports, crons), not just Content Manager saves.
 *   2. detachAffiliateBrand — the cascade behind flipping a Brand to
 *      affiliate: the brand is disconnected from every offer where it is not
 *      the sole merchant, and offers it stays on lose a conflicting checkout
 *      merchant. Invoked from the documents middleware in src/index.ts inside
 *      the brand write's transaction.
 *
 * Brand writes themselves get NO validator: flipping to affiliate is a legal
 * business action, and blocking it until every offer is hand-cleaned would
 * invert the product decision ("brand wins, offers are swept clean").
 */

const BRAND_UID = 'api::brand.brand';
const AFFILIATE_FLAG = 'isAffiliate';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/**
 * Does this offer payload touch any field the affiliate invariant reads?
 * Shared by the validator's touch gate below AND the write pipeline's
 * lock-domain selection (write-validation/run.ts) — the write must take the
 * 'affiliate' serialization lock exactly when this validator will judge its
 * relation state, or the two could disagree and reopen the race the lock
 * closes.
 */
export function touchesAffiliateFields(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return (
    hasOwn(data, 'brands') ||
    hasOwn(data, 'stores') ||
    hasOwn(data, CHECKOUT_MERCHANT_FIELD)
  );
}

/**
 * Does this Store/Brand payload touch its offer inverses? Same
 * validator-and-lock pairing contract as touchesAffiliateFields, for
 * validateEntityOfferAffiliateConnections.
 */
export function touchesEntityOfferRelations(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return hasOwn(data, 'coupons') || hasOwn(data, 'deals');
}

/**
 * WHERE clause matching rows by the mixed identifier forms a relation
 * payload may carry (numeric ids, documentIds, or objects holding either).
 * Same shape handling as deal-of-the-day-validation.ts's private
 * dealRelationWhere. Used against brand rows (offer-side validator) and
 * offer rows (entity-side validator + ISR payload resolution).
 */
function relationEntriesWhere(
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
 * Reject an offer write whose final state pairs an affiliate brand with a
 * Store, another brand, or a foreign checkout merchant.
 *
 * Deliberately NOT gated on isContentManagerWrite — unlike the one-Store cap
 * (an editor-workflow contract), this is a data invariant every write path
 * must honour. The touch gate keeps the status cron's partial
 * `{ contentStatus }` updates from tripping over a leftover-dirty row, and
 * `strict` re-arms the check on the effective record for human saves
 * ("clean as you touch", same as the rest of the pipeline).
 */
export async function validateOfferAffiliateBrands(
  strapi: Core.Strapi,
  uid: OfferStoreUid,
  action: string,
  data: unknown,
  documentId?: string,
  strict: boolean = false,
): Promise<void> {
  if (!['create', 'update', 'clone'].includes(action)) return;
  if (!data || typeof data !== 'object') return;

  const touched = touchesAffiliateFields(data);
  if (!touched && !strict) return;

  // Updates and clones resolve partial relation commands (and the
  // untouched-strict effective record) against the stored row.
  let current: any = null;
  if ((action === 'update' || action === 'clone') && documentId) {
    current = await strapi.documents(uid).findOne({
      documentId,
      fields: ['documentId', CHECKOUT_MERCHANT_FIELD] as any,
      populate: {
        stores: { fields: ['documentId'] },
        brands: { fields: ['documentId'] },
      } as any,
    });
  }
  const currentStores: RelationEntry[] = Array.isArray(current?.stores)
    ? current.stores
    : [];
  const currentBrands: RelationEntry[] = Array.isArray(current?.brands)
    ? current.brands
    : [];

  const incomingStores = hasOwn(data, 'stores')
    ? Reflect.get(data, 'stores')
    : undefined;
  const incomingBrands = hasOwn(data, 'brands')
    ? Reflect.get(data, 'brands')
    : undefined;

  const stores =
    incomingStores === undefined
      ? currentStores
      : (resultingRelations(
          normalizeRelationShorthand(incomingStores),
          currentStores,
        ) ?? []);
  const brands =
    incomingBrands === undefined
      ? currentBrands
      : (resultingRelations(
          normalizeRelationShorthand(incomingBrands),
          currentBrands,
        ) ?? []);
  if (!brands.length) return;

  const merchantValue = hasOwn(data, CHECKOUT_MERCHANT_FIELD)
    ? Reflect.get(data, CHECKOUT_MERCHANT_FIELD)
    : current?.[CHECKOUT_MERCHANT_FIELD];
  const merchant = parseCheckoutMerchant(merchantValue);

  const where = relationEntriesWhere(brands);
  if (!where) return;
  const affiliates: any[] = await strapi.db.query(BRAND_UID).findMany({
    where: { $and: [where, { [AFFILIATE_FLAG]: true }] },
    select: ['id', 'documentId', 'name'],
  });
  if (!affiliates.length) return;

  const names = affiliates
    .map((brand) => brand?.name ?? brand?.documentId ?? String(brand?.id))
    .join(', ');
  const label = affiliates.length === 1 ? 'brand' : 'brands';
  const affiliateDocIds = new Set(
    affiliates
      .map((brand) => brand?.documentId)
      .filter((value): value is string => typeof value === 'string'),
  );

  const problems: Problem[] = [];
  if (brands.length > 1) {
    problems.push({
      path: ['brands'],
      message:
        `Affiliate ${label} ${names} must be the ONLY brand on this offer. ` +
        `Remove the other brand(s), or remove the affiliate ${label}.`,
    });
  }
  if (stores.length > 0) {
    problems.push({
      path: ['brands'],
      message:
        `Affiliate ${label} ${names} cannot be combined with a Store. ` +
        `Remove the Store, or remove the affiliate ${label}.`,
    });
  }
  if (
    merchant &&
    !(merchant.kind === 'brand' && affiliateDocIds.has(merchant.documentId))
  ) {
    problems.push({
      path: [CHECKOUT_MERCHANT_FIELD],
      message:
        `Checkout merchant must be empty or the affiliate ${label} ${names} ` +
        `while an affiliate brand is selected — it cannot point at a ` +
        `${merchant.kind === 'store' ? 'Store' : 'different Brand'}.`,
    });
  }

  if (problems.length) throw toValidationError(problems);
}

const ENTITY_OFFER_FIELDS = [
  { field: 'coupons', uid: 'api::coupon.coupon', label: 'Coupon' },
  { field: 'deals', uid: 'api::deal.deal', label: 'Product Deal' },
] as const satisfies ReadonlyArray<{
  field: string;
  uid: OfferStoreUid;
  label: string;
}>;

export type AffiliateEntityUid = 'api::store.store' | typeof BRAND_UID;

export function isAffiliateEntityUid(uid: string): uid is AffiliateEntityUid {
  return uid === 'api::store.store' || uid === BRAND_UID;
}

/** Final − current, matched on any shared id/documentId key. */
function addedRelations(
  final: readonly RelationEntry[],
  current: readonly RelationEntry[],
): RelationEntry[] {
  const currentKeys = new Set(current.flatMap((entry) => relationKeys(entry)));
  return final.filter(
    (entry) => !relationKeys(entry).some((key) => currentKeys.has(key)),
  );
}

/**
 * The inverse-side guard: `brand.coupons` / `brand.deals` / `store.coupons` /
 * `store.deals` are real writable mappings, so a Store or Brand save can
 * rewire offers without ever producing an offer write — and
 * validateOfferAffiliateBrands never sees it. This validator judges every
 * offer the payload NEWLY CONNECTS:
 *
 *   - a Store may not join an offer that has an affiliate brand;
 *   - a plain Brand may not join an offer that has an affiliate brand;
 *   - an affiliate Brand may only join an offer with no Store, no other
 *     brand, and no checkout merchant pointing anywhere but at itself.
 *
 * Disconnects are ignored (removal cannot create a violation), and already-
 * connected offers are filtered out of full-replacement (array/set) payloads,
 * so an unrelated entity save never re-litigates legacy state. Runs in the
 * LOCKED group under the 'affiliate' domain — the same lock the offer-side
 * validator and the flip cascade hold.
 */
export async function validateEntityOfferAffiliateConnections(
  strapi: Core.Strapi,
  uid: AffiliateEntityUid,
  action: string,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (!['create', 'update', 'clone'].includes(action)) return;
  if (!touchesEntityOfferRelations(data)) return;

  const touchedFields = ENTITY_OFFER_FIELDS.filter(({ field }) =>
    hasOwn(data as object, field),
  );

  // Current inverse relations resolve full-replacement payloads into a
  // NEWLY-ADDED set; for a brand the stored flag also decides which rule
  // applies when the payload does not carry isAffiliate.
  let current: any = null;
  if ((action === 'update' || action === 'clone') && documentId) {
    current = await strapi.documents(uid as any).findOne({
      documentId,
      fields: (uid === BRAND_UID
        ? ['documentId', AFFILIATE_FLAG]
        : ['documentId']) as any,
      populate: Object.fromEntries(
        touchedFields.map(({ field }) => [field, { fields: ['documentId'] }]),
      ) as any,
    });
  }

  const savedBrandAffiliate =
    uid === BRAND_UID &&
    (hasOwn(data as object, AFFILIATE_FLAG)
      ? Reflect.get(data as object, AFFILIATE_FLAG) === true
      : current?.[AFFILIATE_FLAG] === true);

  const problems: Problem[] = [];

  for (const { field, uid: offerUid, label } of touchedFields) {
    const currentEntries: RelationEntry[] = Array.isArray(current?.[field])
      ? current[field]
      : [];
    const final =
      resultingRelations(
        normalizeRelationShorthand(Reflect.get(data as object, field)),
        currentEntries,
      ) ?? [];
    const added = addedRelations(final, currentEntries);
    if (!added.length) continue;

    const where = relationEntriesWhere(added);
    if (!where) continue;
    const offers: any[] = await strapi.db.query(offerUid).findMany({
      where,
      select: ['id', 'documentId', 'title', CHECKOUT_MERCHANT_FIELD],
      populate: {
        stores: { select: ['id'] },
        brands: { select: ['id', 'documentId', 'name', AFFILIATE_FLAG] },
      },
    } as any);

    for (const offer of offers) {
      const title = offer?.title ?? offer?.documentId ?? String(offer?.id);
      const offerBrands: any[] = Array.isArray(offer?.brands)
        ? offer.brands
        : [];
      const affiliateOnOffer = offerBrands.filter(
        (brand) => brand?.[AFFILIATE_FLAG] === true,
      );

      if (uid === 'api::store.store' || !savedBrandAffiliate) {
        if (affiliateOnOffer.length === 0) continue;
        const names = affiliateOnOffer
          .map((brand) => brand?.name ?? brand?.documentId)
          .join(', ');
        const attached = uid === 'api::store.store' ? 'a Store' : 'other brands';
        problems.push({
          path: [field],
          message:
            `${label} "${title}" belongs to affiliate brand ${names}, ` +
            `which must stay its only merchant — ${attached} cannot be ` +
            `attached to it. Remove that offer from this selection.`,
        });
        continue;
      }

      // The saved brand IS affiliate: it may only join a bare offer.
      const storeCount = Array.isArray(offer?.stores) ? offer.stores.length : 0;
      const otherBrands = offerBrands.filter(
        (brand) => brand?.documentId !== documentId,
      );
      const merchant = parseCheckoutMerchant(offer?.[CHECKOUT_MERCHANT_FIELD]);
      const merchantForeign =
        merchant &&
        !(merchant.kind === 'brand' && merchant.documentId === documentId);
      if (storeCount === 0 && otherBrands.length === 0 && !merchantForeign) {
        continue;
      }
      problems.push({
        path: [field],
        message:
          `${label} "${title}" already has ` +
          `${storeCount > 0 ? 'a Store' : otherBrands.length > 0 ? 'other brands' : 'a different checkout merchant'}` +
          ` — an affiliate brand must be its only merchant. Remove that ` +
          `offer from this selection, or clean the offer up first.`,
      });
    }
  }

  if (problems.length) throw toValidationError(problems);
}

/**
 * The Store/Brand's stored coupons/deals membership, as documentId sets —
 * captured before AND after an entity write that touches the offer inverses.
 * Diffing two snapshots (below) yields exactly the offers whose membership
 * changed, for ISR invalidation. Payload parsing cannot do this job: a
 * replacement array or `[]`/`null`/`{ set: [] }` clear never NAMES the
 * offers it removes, and unioning the whole baseline instead would escalate
 * a store's single connect past the invalidation cap into a full rebuild.
 */
export type EntityOfferSnapshot = Record<OfferStoreUid, ReadonlySet<string>>;

export const EMPTY_ENTITY_OFFER_SNAPSHOT: EntityOfferSnapshot = {
  'api::coupon.coupon': new Set(),
  'api::deal.deal': new Set(),
};

export async function snapshotEntityOfferRelations(
  strapi: Core.Strapi,
  uid: AffiliateEntityUid,
  documentId: string,
): Promise<EntityOfferSnapshot> {
  const doc: any = await strapi.documents(uid as any).findOne({
    documentId,
    fields: ['documentId'] as any,
    populate: {
      coupons: { fields: ['documentId'] },
      deals: { fields: ['documentId'] },
    } as any,
  });
  const collect = (value: unknown): ReadonlySet<string> =>
    new Set(
      (Array.isArray(value) ? value : [])
        .map((row: any) => row?.documentId)
        .filter((id: unknown): id is string => typeof id === 'string'),
    );
  return {
    'api::coupon.coupon': collect(doc?.coupons),
    'api::deal.deal': collect(doc?.deals),
  };
}

/** Symmetric difference per offer type: everything added OR removed. */
export function diffEntityOfferSnapshots(
  before: EntityOfferSnapshot,
  after: EntityOfferSnapshot,
): Array<{ uid: OfferStoreUid; documentId: string }> {
  const changed: Array<{ uid: OfferStoreUid; documentId: string }> = [];
  for (const uid of OFFER_STORE_UIDS) {
    for (const documentId of before[uid]) {
      if (!after[uid].has(documentId)) changed.push({ uid, documentId });
    }
    for (const documentId of after[uid]) {
      if (!before[uid].has(documentId)) changed.push({ uid, documentId });
    }
  }
  return changed;
}

export type AffiliateCascadeResult = {
  /** Every offer whose stored content changed — the ISR invalidation set. */
  affected: Array<{ uid: OfferStoreUid; documentId: string }>;
  detachedCount: number;
  merchantsClearedCount: number;
};

/**
 * Sweep every offer clean after a Brand becomes affiliate: the brand is
 * disconnected wherever it shares the offer with a Store or another brand
 * (those stay), and offers it remains sole on lose a checkout merchant that
 * points anywhere but at this brand.
 *
 * MUST run with the brand write's transaction in scope — `strapi.db.query`
 * joins the ambient transaction through AsyncLocalStorage (AGENTS.md), so the
 * sweep commits atomically with the flip. Going through the db layer rather
 * than the documents service is deliberate: a documents-service update of the
 * offers would re-enter the record-lock middleware (an offer open in another
 * editor's tab would abort the brand save) and re-run strict validation on
 * legacy-dirty offers (the brand save would fail on unrelated fields).
 * The price — no automatic ISR enqueue for the offers — is paid back by the
 * caller, which merges `affected` into the brand event's scope.
 *
 * Idempotent: re-disconnecting and re-nulling are no-ops.
 */
export async function detachAffiliateBrand(
  strapi: Core.Strapi,
  brandDocumentId: string,
): Promise<AffiliateCascadeResult> {
  const result: AffiliateCascadeResult = {
    affected: [],
    detachedCount: 0,
    merchantsClearedCount: 0,
  };

  const brand: any = await strapi.db.query(BRAND_UID).findOne({
    where: { documentId: brandDocumentId },
    select: ['id'],
  });
  if (!brand) return result;

  const allowedMerchant = `brand:${brandDocumentId}`;

  for (const uid of OFFER_STORE_UIDS) {
    const query = strapi.db.query(uid);
    const offers: any[] = await query.findMany({
      where: { brands: { documentId: brandDocumentId } },
      select: ['id', 'documentId', CHECKOUT_MERCHANT_FIELD],
      populate: {
        stores: { select: ['id'] },
        brands: { select: ['id'] },
      },
    } as any);

    for (const offer of offers) {
      const storeCount = Array.isArray(offer?.stores) ? offer.stores.length : 0;
      const brandCount = Array.isArray(offer?.brands) ? offer.brands.length : 0;

      if (storeCount > 0 || brandCount > 1) {
        await query.update({
          where: { id: offer.id },
          data: { brands: { disconnect: [brand.id] } },
        } as any);
        result.detachedCount += 1;
        result.affected.push({ uid, documentId: offer.documentId });
        continue;
      }

      const merchant = offer?.[CHECKOUT_MERCHANT_FIELD];
      if (
        typeof merchant === 'string' &&
        merchant.trim() !== '' &&
        merchant.trim() !== allowedMerchant
      ) {
        await query.update({
          where: { id: offer.id },
          data: { [CHECKOUT_MERCHANT_FIELD]: null },
        } as any);
        result.merchantsClearedCount += 1;
        result.affected.push({ uid, documentId: offer.documentId });
      }
    }
  }

  return result;
}
