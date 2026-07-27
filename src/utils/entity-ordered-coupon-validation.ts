import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from './content-status';
import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import {
  ENTITY_TOP_PICK_UIDS,
  type EntityTopPickUid,
} from './entity-top-pick-validation';
import { toValidationError } from './write-validation/problems';

export const ENTITY_ORDERED_COUPON_MAX = 10;

const COUPON_RELATION_BY_UID: Record<EntityTopPickUid, string> = {
  'api::store.store': 'stores',
  'api::brand.brand': 'brands',
  'api::bank.bank': 'banks',
  'api::category.category': 'categories',
};

const reject = (message: string): never => {
  throw toValidationError([{ path: ['orderedCoupons'], message }]);
};

export function isEntityOrderedCouponUid(
  uid: string,
): uid is EntityTopPickUid {
  return ENTITY_TOP_PICK_UIDS.includes(uid as EntityTopPickUid);
}

function populatedRelations(
  document: unknown,
  field: 'orderedCoupons',
): RelationEntry[] {
  if (!document || typeof document !== 'object') return [];
  const value = Reflect.get(document, field);
  return Array.isArray(value) ? value : [];
}

/**
 * Ordered Coupons are an editorial projection, not entity membership:
 * membership continues to come from Coupon taxonomies. Validate the projection
 * whenever it changes.
 *
 * This no longer runs for a Top-Picks-only write. It used to, solely to catch
 * a Coupon selected in both relations — a ban that has been lifted (see the
 * note further down). Reacting to `topPickCoupons` now would only mean an
 * unrelated Top Pick edit could be rejected for a pre-existing Ordered
 * Coupons problem it did not cause.
 */
export async function validateEntityOrderedCoupons(
  strapi: Core.Strapi,
  uid: EntityTopPickUid,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(data, 'orderedCoupons')) return;

  const current: unknown = documentId
    ? await strapi.documents(uid).findOne({
        documentId,
        fields: ['documentId'],
        populate: { orderedCoupons: { fields: ['documentId'] } },
      })
    : null;

  const currentOrdered = populatedRelations(current, 'orderedCoupons');
  const ordered =
    resultingRelations(Reflect.get(data, 'orderedCoupons'), currentOrdered) ??
    currentOrdered;

  if (ordered.length > ENTITY_ORDERED_COUPON_MAX) {
    const overBy = ordered.length - ENTITY_ORDERED_COUPON_MAX;
    reject(
      `Ordered Coupons accepts at most ${ENTITY_ORDERED_COUPON_MAX} Coupons. ` +
        `Remove ${overBy} Coupon${overBy === 1 ? '' : 's'}.`,
    );
  }

  // NO OVERLAP CHECK. Top Picks 3–4 are expiry buffers that stay invisible
  // until an earlier pick dies, so they are legitimately orderable in the main
  // list meanwhile. Only the two DISPLAYED picks must stay out of
  // `orderedCoupons`, and that is positional — which this validator cannot
  // evaluate:
  //
  //   - `resultingRelations` returns the right SET but the wrong ORDER. It
  //     computes uniqueRelations([...current, ...connect]), keeping the first
  //     occurrence, so a pure drag-reorder resolves back to the OLD order;
  //     Strapi's before/end position anchors are ignored entirely.
  //   - The cleanup job writes through `strapi.db.query`, bypassing this
  //     middleware. Once it promotes a buffer that is also ordered, a
  //     positional rule here would reject EVERY later save of that entity,
  //     including edits unrelated to Coupons.
  //
  // The invariant is therefore maintained by repair, not rejection:
  // `removeDisplayedTopPicksFromOrdered` in utils/curated-offer-relations.ts
  // drops a displayed pick out of `orderedCoupons` on the five-minute cron,
  // and the admin dialog blocks the overlap up front. The storefront already
  // degrades safely in the meantime — a displayed Top Pick is removed from the
  // main list, so the ordered head simply closes up.

  if (ordered.length === 0) return;
  if (!documentId) {
    reject(
      'Save this entity before selecting Ordered Coupons so only its related Coupons can be chosen.',
    );
  }

  const documentIds = ordered.flatMap((selection) => {
    if (typeof selection === 'string') return [selection];
    if (!selection || typeof selection !== 'object') return [];
    const value = Reflect.get(selection, 'documentId');
    return typeof value === 'string' && value ? [value] : [];
  });
  const numericIds = ordered.flatMap((selection) => {
    if (typeof selection === 'number') return [selection];
    if (!selection || typeof selection !== 'object') return [];
    const value = Reflect.get(selection, 'id');
    return typeof value === 'number' ? [value] : [];
  });
  const identityFilters = [
    ...(documentIds.length
      ? [{ documentId: { $in: [...new Set(documentIds)] } }]
      : []),
    ...(numericIds.length ? [{ id: { $in: [...new Set(numericIds)] } }] : []),
  ];

  if (!identityFilters.length) {
    reject(
      'Ordered Coupons contains an unavailable Coupon. Remove it and select again.',
    );
  }

  const eligibleCoupons: unknown = await strapi
    .documents('api::coupon.coupon')
    .findMany({
      filters: {
        $and: [
          identityFilters.length === 1
            ? identityFilters[0]
            : { $or: identityFilters },
          { [COUPON_RELATION_BY_UID[uid]]: { documentId } },
          publishedOnlyFilters(),
        ],
      },
      fields: ['documentId'],
      limit: ENTITY_ORDERED_COUPON_MAX,
    });
  const eligible = Array.isArray(eligibleCoupons) ? eligibleCoupons : [];
  const invalid = ordered.filter((selection) => {
    const selectedKeys = new Set(relationKeys(selection));
    return !eligible.some((coupon) =>
      relationKeys(coupon).some((key) => selectedKeys.has(key)),
    );
  });

  if (!invalid.length) return;
  const label = uid.split('::')[1]?.split('.')[0] ?? 'entity';
  reject(
    `Ordered Coupons must be published Coupons related to this ${label}. ` +
      `Remove ${invalid.length} unrelated or unavailable Coupon` +
      `${invalid.length === 1 ? '' : 's'}.`,
  );
}
