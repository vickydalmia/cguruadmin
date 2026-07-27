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

type CouponSelectionPath = 'orderedCoupons' | 'topPickCoupons';

const reject = (path: CouponSelectionPath, message: string): never => {
  throw toValidationError([{ path: [path], message }]);
};

export function isEntityOrderedCouponUid(
  uid: string,
): uid is EntityTopPickUid {
  return ENTITY_TOP_PICK_UIDS.includes(uid as EntityTopPickUid);
}

function populatedRelations(
  document: unknown,
  field: 'orderedCoupons' | 'topPickCoupons',
): RelationEntry[] {
  if (!document || typeof document !== 'object') return [];
  const value = Reflect.get(document, field);
  return Array.isArray(value) ? value : [];
}

function sharesRelation(
  candidate: RelationEntry,
  others: readonly RelationEntry[],
): boolean {
  const keys = new Set(relationKeys(candidate));
  return others.some((other) =>
    relationKeys(other).some((key) => keys.has(key)),
  );
}

/**
 * Ordered Coupons are an editorial projection, not entity membership:
 * membership continues to come from Coupon taxonomies. Validate the projection
 * on every change to it or Top Picks so the two page sections can never select
 * the same Coupon.
 */
export async function validateEntityOrderedCoupons(
  strapi: Core.Strapi,
  uid: EntityTopPickUid,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (!data || typeof data !== 'object') return;

  const orderedTouched = Object.prototype.hasOwnProperty.call(
    data,
    'orderedCoupons',
  );
  const topPicksTouched = Object.prototype.hasOwnProperty.call(
    data,
    'topPickCoupons',
  );
  if (!orderedTouched && !topPicksTouched) return;

  const current: unknown = documentId
    ? await strapi.documents(uid).findOne({
        documentId,
        fields: ['documentId'],
        populate: {
          orderedCoupons: { fields: ['documentId'] },
          topPickCoupons: { fields: ['documentId'] },
        },
      })
    : null;

  const currentOrdered = populatedRelations(current, 'orderedCoupons');
  const currentTopPicks = populatedRelations(current, 'topPickCoupons');
  const ordered = orderedTouched
    ? resultingRelations(Reflect.get(data, 'orderedCoupons'), currentOrdered) ??
      currentOrdered
    : currentOrdered;
  const topPicks = topPicksTouched
    ? resultingRelations(Reflect.get(data, 'topPickCoupons'), currentTopPicks) ??
      currentTopPicks
    : currentTopPicks;

  if (ordered.length > ENTITY_ORDERED_COUPON_MAX) {
    const overBy = ordered.length - ENTITY_ORDERED_COUPON_MAX;
    reject(
      'orderedCoupons',
      `Ordered Coupons accepts at most ${ENTITY_ORDERED_COUPON_MAX} Coupons. ` +
        `Remove ${overBy} Coupon${overBy === 1 ? '' : 's'}.`,
    );
  }

  const overlap = ordered.filter((coupon) =>
    sharesRelation(coupon, topPicks),
  );
  if (overlap.length > 0) {
    const message =
      'Top Pick Coupons cannot also be selected in Ordered Coupons. ' +
      `Remove ${overlap.length} duplicate Coupon${overlap.length === 1 ? '' : 's'}.`;
    const paths: CouponSelectionPath[] =
      orderedTouched && topPicksTouched
        ? ['orderedCoupons', 'topPickCoupons']
        : [topPicksTouched ? 'topPickCoupons' : 'orderedCoupons'];
    throw toValidationError(paths.map((path) => ({ path: [path], message })));
  }

  if (!orderedTouched || ordered.length === 0) return;
  if (!documentId) {
    reject(
      'orderedCoupons',
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
      'orderedCoupons',
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
    'orderedCoupons',
    `Ordered Coupons must be published Coupons related to this ${label}. ` +
      `Remove ${invalid.length} unrelated or unavailable Coupon` +
      `${invalid.length === 1 ? '' : 's'}.`,
  );
}
