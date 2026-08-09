import type { Core } from '@strapi/strapi';

import {
  CHECKOUT_MERCHANT_FIELD,
  formatCheckoutMerchant,
  parseCheckoutMerchant,
} from '../constants/checkout-merchant';
import {
  normalizeRelationShorthand,
  OFFER_STORE_UIDS,
  type OfferStoreUid,
} from './content-manager-offer-store-validation';
import {
  relationEntriesWhere,
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { resolveWritePayload } from './write-validation/payload';
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
 *      merchant. Invoked from
 *      src/document-middlewares/apply-transactional-maintenance.ts inside the
 *      brand write's transaction.
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
  recheck: boolean = false,
): Promise<void> {
  if (!['create', 'update', 'clone'].includes(action)) return;

  // A bare clone still inherits every source relation and checkoutMerchant —
  // its missing payload normalizes to an empty override so validation judges
  // the copied state rather than silently accepting it.
  const payload = resolveWritePayload(action, data);
  if (!payload) return;

  const touched = touchesAffiliateFields(payload);
  if (!touched && !strict && action !== 'clone') return;

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

  const incomingStores = hasOwn(payload, 'stores')
    ? Reflect.get(payload, 'stores')
    : undefined;
  const incomingBrands = hasOwn(payload, 'brands')
    ? Reflect.get(payload, 'brands')
    : undefined;

  // An unrecognized relation payload shape falls back to the STORED state,
  // never to "no relations" — the ORM treats e.g. `brands: {}` as a no-op,
  // so coercing it to empty would let a Store connect slip past the check
  // while the stored affiliate brand survives the write.
  const stores =
    incomingStores === undefined
      ? currentStores
      : (resultingRelations(
          normalizeRelationShorthand(incomingStores),
          currentStores,
        ) ?? currentStores);
  const brands =
    incomingBrands === undefined
      ? currentBrands
      : (resultingRelations(
          normalizeRelationShorthand(incomingBrands),
          currentBrands,
        ) ?? currentBrands);

  const merchantValue = hasOwn(payload, CHECKOUT_MERCHANT_FIELD)
    ? Reflect.get(payload, CHECKOUT_MERCHANT_FIELD)
    : current?.[CHECKOUT_MERCHANT_FIELD];
  const merchant = parseCheckoutMerchant(merchantValue);
  if (!brands.length && !(merchant?.kind === 'brand')) return;

  const evaluate = async (): Promise<Problem[]> => {
    // One lookup covers the relation brands AND a brand-kind merchant, so a
    // store-only offer pointing its checkout merchant at an affiliate brand
    // (no brands relation at all) is judged by the same rule.
    const lookupEntries: RelationEntry[] = [
      ...brands,
      ...(merchant?.kind === 'brand' ? [merchant.documentId] : []),
    ];
    const where = relationEntriesWhere(lookupEntries);
    if (!where) return [];
    const affiliateRows: any[] = await strapi.db.query(BRAND_UID).findMany({
      where: { $and: [where, { [AFFILIATE_FLAG]: true }] },
      select: ['id', 'documentId', 'name'],
    });
    if (!affiliateRows.length) return [];

    const relationKeySet = new Set(brands.flatMap((b) => relationKeys(b)));
    const affiliates = affiliateRows.filter((row) =>
      [row?.documentId, row?.id]
        .filter((key) => key !== undefined && key !== null)
        .some((key) => relationKeySet.has(String(key))),
    );
    const merchantAffiliate =
      merchant?.kind === 'brand'
        ? (affiliateRows.find((row) => row?.documentId === merchant.documentId) ??
          null)
        : null;

    const problems: Problem[] = [];

    if (affiliates.length > 0) {
      const names = affiliates
        .map((brand) => brand?.name ?? brand?.documentId ?? String(brand?.id))
        .join(', ');
      const label = affiliates.length === 1 ? 'brand' : 'brands';
      const affiliateDocIds = new Set(
        affiliates
          .map((brand) => brand?.documentId)
          .filter((value): value is string => typeof value === 'string'),
      );
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
    }

    // Merchant points at an affiliate brand that is NOT among the selected
    // brands: the exclusivity rule follows the merchant reference too, or a
    // store-owned offer could check out through an affiliate brand. Only
    // when no affiliate brand is selected — otherwise the block above has
    // already reported this exact merchant conflict on the same path.
    if (merchantAffiliate && affiliates.length === 0) {
      const name =
        merchantAffiliate.name ?? merchantAffiliate.documentId ?? 'this brand';
      if (stores.length > 0) {
        problems.push({
          path: [CHECKOUT_MERCHANT_FIELD],
          message:
            `Checkout merchant ${name} is an affiliate brand — it cannot be ` +
            `combined with a Store. Clear the merchant or remove the Store.`,
        });
      }
      if (brands.length > 0) {
        problems.push({
          path: [CHECKOUT_MERCHANT_FIELD],
          message:
            `Checkout merchant ${name} is an affiliate brand — it cannot be ` +
            `combined with other brands. Clear the merchant or remove the ` +
            `brand(s).`,
        });
      }
    }

    return problems;
  };

  const problems = await evaluate();
  if (problems.length && !touched && !recheck && action !== 'clone') {
    // Untouched-strict saves run WITHOUT the affiliate lock (nothing they
    // write can create a violation), so a concurrent flip can tear the offer
    // read and the brand-flag read apart and compose a state that never
    // existed. Re-running the whole resolution once filters that transient
    // out; a REAL legacy violation reproduces on fresh reads. Clones are
    // exempt: they DO hold the affiliate lock (lockDomainsFor), so their
    // reads cannot tear and a retry would only re-run both queries inside
    // the lock window before throwing the same rejection.
    return validateOfferAffiliateBrands(
      strapi,
      uid,
      action,
      data,
      documentId,
      strict,
      true,
    );
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
 *   - a Store may not join an offer that has an affiliate brand — related OR
 *     referenced through `checkoutMerchant` (a store-only offer may legally
 *     check out through an affiliate brand, so the reference alone must
 *     block the connection);
 *   - a plain Brand may not join such an offer either;
 *   - an affiliate Brand may only join an offer with no Store, no other
 *     brand, and no checkout merchant pointing anywhere but at itself;
 *   - CLONING an affiliate Brand that has offers is rejected outright: the
 *     deep-copied connections would pair the clone with the SOURCE brand on
 *     every offer, and the post-write cascade would then silently strip the
 *     clone again — reject up front instead of committing a self-destructing
 *     write. (Overriding the clone payload with empty `coupons`/`deals`
 *     still passes.)
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
  // A clone is judged REGARDLESS of payload: Strapi deep-copies the source's
  // relations before merging the submitted data, so a bare {name, slug}
  // duplicate still re-attaches this entity to every source offer.
  const payload = resolveWritePayload(action, data);
  if (!payload) return;
  if (!touchesEntityOfferRelations(payload) && action !== 'clone') return;

  const touchedFields =
    action === 'clone'
      ? [...ENTITY_OFFER_FIELDS]
      : ENTITY_OFFER_FIELDS.filter(({ field }) => hasOwn(payload, field));

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
    (hasOwn(payload, AFFILIATE_FLAG)
      ? Reflect.get(payload, AFFILIATE_FLAG) === true
      : current?.[AFFILIATE_FLAG] === true);

  const problems: Problem[] = [];

  for (const { field, uid: offerUid, label } of touchedFields) {
    const currentEntries: RelationEntry[] = Array.isArray(current?.[field])
      ? current[field]
      : [];
    const incoming = hasOwn(payload, field)
      ? (resultingRelations(
          normalizeRelationShorthand(Reflect.get(payload, field)),
          currentEntries,
          // Unknown payload shape falls back to the stored/copied state, not
          // to "no relations" — same rule as the offer-side validator.
        ) ?? currentEntries)
      : currentEntries;
    // For a clone every connection is NEW: `current` describes the SOURCE
    // document, but the WRITTEN document did not exist, so its baseline is
    // empty — diffing against the source would wrongly subtract the
    // inherited set and validate nothing.
    const added =
      action === 'clone'
        ? incoming
        : addedRelations(incoming, currentEntries);
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

    // A brand-kind checkout merchant is a merchant reference the offer-side
    // validator honours even with NO brands relation, so this side must too.
    // The referenced brand is usually not among the populated offer brands
    // (that is the merchant-only case) — resolve all referenced brands'
    // affiliate flags in one batch.
    const merchantBrandDocIds = [
      ...new Set(
        offers
          .map((offer) =>
            parseCheckoutMerchant(offer?.[CHECKOUT_MERCHANT_FIELD]),
          )
          .filter((ref) => ref?.kind === 'brand')
          .map((ref) => (ref as { documentId: string }).documentId),
      ),
    ];
    const affiliateMerchantBrands = new Map<string, { name?: string }>();
    if (merchantBrandDocIds.length) {
      const rows: any[] = await strapi.db.query(BRAND_UID).findMany({
        where: {
          documentId: { $in: merchantBrandDocIds },
          [AFFILIATE_FLAG]: true,
        },
        select: ['documentId', 'name'],
      });
      for (const row of rows) {
        if (typeof row?.documentId === 'string') {
          affiliateMerchantBrands.set(row.documentId, { name: row?.name });
        }
      }
    }

    for (const offer of offers) {
      const title = offer?.title ?? offer?.documentId ?? String(offer?.id);
      const offerBrands: any[] = Array.isArray(offer?.brands)
        ? offer.brands
        : [];
      const affiliateOnOffer = offerBrands.filter(
        (brand) => brand?.[AFFILIATE_FLAG] === true,
      );

      if (uid === 'api::store.store' || !savedBrandAffiliate) {
        const attached = uid === 'api::store.store' ? 'a Store' : 'other brands';
        if (affiliateOnOffer.length > 0) {
          const names = affiliateOnOffer
            .map((brand) => brand?.name ?? brand?.documentId)
            .join(', ');
          problems.push({
            path: [field],
            message:
              `${label} "${title}" belongs to affiliate brand ${names}, ` +
              `which must stay its only merchant — ${attached} cannot be ` +
              `attached to it. Remove that offer from this selection.`,
          });
          continue;
        }
        const merchantRef = parseCheckoutMerchant(
          offer?.[CHECKOUT_MERCHANT_FIELD],
        );
        const merchantAffiliate =
          merchantRef?.kind === 'brand'
            ? (affiliateMerchantBrands.get(merchantRef.documentId) ?? null)
            : null;
        if (merchantAffiliate) {
          const name = merchantAffiliate.name ?? merchantRef!.documentId;
          problems.push({
            path: [field],
            message:
              `${label} "${title}" checks out through affiliate brand ` +
              `${name} (its checkout merchant), which must stay its only ` +
              `merchant — ${attached} cannot be attached to it. Remove that ` +
              `offer from this selection, or clear its checkout merchant ` +
              `first.`,
          });
        }
        continue;
      }

      // The saved brand IS affiliate: it may only join a bare offer. For a
      // CLONE the written brand is a brand-new document, so relative to it
      // the SOURCE brand on each inherited offer is another brand, and a
      // merchant pointing at the source is foreign — no filtering by the
      // source documentId (which is what `documentId` holds during a clone).
      const storeCount = Array.isArray(offer?.stores) ? offer.stores.length : 0;
      const otherBrands =
        action === 'clone'
          ? offerBrands
          : offerBrands.filter((brand) => brand?.documentId !== documentId);
      const merchant = parseCheckoutMerchant(offer?.[CHECKOUT_MERCHANT_FIELD]);
      const merchantForeign =
        merchant &&
        !(
          action !== 'clone' &&
          merchant.kind === 'brand' &&
          merchant.documentId === documentId
        );
      if (storeCount === 0 && otherBrands.length === 0 && !merchantForeign) {
        continue;
      }
      if (action === 'clone') {
        problems.push({
          path: [field],
          message:
            `Cloning this affiliate brand would attach a second affiliate ` +
            `brand to ${label} "${title}" — an affiliate brand must be its ` +
            `only merchant. Clone it without offers (clear Coupons and ` +
            `Product Deals on the clone), or detach the offers from the ` +
            `source brand first.`,
        });
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
  trx: any,
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

  const allowedMerchant = formatCheckoutMerchant({
    kind: 'brand',
    documentId: brandDocumentId,
  });

  for (const uid of OFFER_STORE_UIDS) {
    const query = strapi.db.query(uid);
    // One pass covers BOTH reference forms: offers holding the brand in
    // their relation, and offers merely POINTING their checkout merchant at
    // it (a flip must not leave a store-owned offer checking out through an
    // affiliate brand it is not even related to).
    const offers: any[] = await query.findMany({
      where: {
        $or: [
          { brands: { documentId: brandDocumentId } },
          { [CHECKOUT_MERCHANT_FIELD]: allowedMerchant },
        ],
      },
      select: ['id', 'documentId', CHECKOUT_MERCHANT_FIELD],
      populate: {
        stores: { select: ['id'] },
        brands: { select: ['id', 'documentId'] },
      },
    } as any);

    const detachIds: Array<string | number> = [];
    const merchantClearIds: Array<string | number> = [];
    for (const offer of offers) {
      const offerBrands: any[] = Array.isArray(offer?.brands)
        ? offer.brands
        : [];
      const storeCount = Array.isArray(offer?.stores) ? offer.stores.length : 0;
      const holdsBrand = offerBrands.some(
        (row) => row?.documentId === brandDocumentId,
      );
      const otherBrandCount = offerBrands.filter(
        (row) => row?.documentId !== brandDocumentId,
      ).length;
      const merchantRaw = offer?.[CHECKOUT_MERCHANT_FIELD];
      const merchantValue =
        typeof merchantRaw === 'string' ? merchantRaw.trim() : '';
      const conflicted = storeCount > 0 || otherBrandCount > 0;
      let changed = false;

      if (holdsBrand && conflicted) {
        detachIds.push(offer.id);
        result.detachedCount += 1;
        changed = true;
        // The brand leaves this offer, so a merchant still POINTING at it
        // would dangle unguarded (the offer-side validator no-ops once the
        // brands relation is empty of affiliates) — clear it with the
        // disconnect, not just on the sole-brand path.
        if (merchantValue === allowedMerchant) {
          merchantClearIds.push(offer.id);
        }
      } else if (holdsBrand) {
        // Sole merchant: the brand stays; a merchant pointing anywhere else
        // is cleared.
        if (merchantValue !== '' && merchantValue !== allowedMerchant) {
          merchantClearIds.push(offer.id);
          changed = true;
        }
      } else if (merchantValue === allowedMerchant && conflicted) {
        // Merchant-only reference on an offer with a store/other brands.
        merchantClearIds.push(offer.id);
        changed = true;
      }

      if (changed) {
        result.affected.push({ uid, documentId: offer.documentId });
      }
    }

    // Batched writes: a legacy brand can sit on hundreds of offers, and this
    // runs inside the brand write's transaction while the fail-closed
    // 'affiliate' advisory lock is held — per-offer relation updates would
    // stretch the hold past waiters' lock_timeout and turn their saves into
    // rejections. The join-table delete goes through `trx` (the SAME
    // transaction the documents middleware passes in), never a second pool
    // connection.
    if (detachIds.length > 0) {
      const joinTable = (strapi.db.metadata.get(uid) as any)?.attributes
        ?.brands?.joinTable;
      if (joinTable?.name) {
        // Deleting link rows directly leaves the join table's order columns
        // un-renumbered (gaps, not reorders) — Strapi renumbers on the next
        // ORM relation write, and nothing reads the columns as contiguous.
        await trx(joinTable.name)
          .where(joinTable.inverseJoinColumn.name, brand.id)
          .whereIn(joinTable.joinColumn.name, detachIds)
          .delete();
      } else {
        // Metadata shape drift: fall back to per-offer ORM disconnects
        // rather than silently skipping the sweep.
        for (const id of detachIds) {
          await query.update({
            where: { id },
            data: { brands: { disconnect: [brand.id] } },
          } as any);
        }
      }
    }
    if (merchantClearIds.length > 0) {
      const updated: any = await query.updateMany({
        where: { id: { $in: merchantClearIds } },
        data: { [CHECKOUT_MERCHANT_FIELD]: null },
      } as any);
      // Count what the write reports, not what was queued — the log line the
      // caller prints should reflect rows actually changed.
      result.merchantsClearedCount += Number(
        updated?.count ?? merchantClearIds.length,
      );
    }
  }

  return result;
}
