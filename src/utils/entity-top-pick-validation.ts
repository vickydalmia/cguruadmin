import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from './content-status';
import {
  relationKeys,
  resultingRelations,
} from './deal-of-the-day-validation';
import { toValidationError } from './write-validation/problems';

/**
 * NOTE ON REPORTING. Unlike its sibling validators this file does not
 * accumulate a problem list, because its checks are reached in sequence and
 * only one can apply to a given selection: an over-maximum selection stops
 * there, and the membership and liveness checks are only reachable once the
 * count is in range. There is never more than one thing to say about
 * `topPickCoupons`, so each check throws where it stands — through the shared
 * `toValidationError`, so the wire shape and toast wording match every other
 * validator.
 */
const reject = (message: string): never => {
  throw toValidationError([{ path: ['topPickCoupons'], message }]);
};

/**
 * Accepts zero Coupons, or 1–4.
 *
 * There is deliberately no minimum. A single selection is valid: the
 * storefront keeps it in slot one and fills slot two with the newest eligible
 * Coupon (`selectEntityTopPicks` in cguru-ui). Requiring two forced editors to
 * pad a selection they did not want.
 */
export const ENTITY_TOP_PICK_COUPON_MAX = 4;

export const ENTITY_TOP_PICK_UIDS = [
  'api::store.store',
  'api::brand.brand',
  'api::bank.bank',
  'api::category.category',
] as const;

export type EntityTopPickUid = (typeof ENTITY_TOP_PICK_UIDS)[number];

const COUPON_RELATION_BY_UID: Record<EntityTopPickUid, string> = {
  'api::store.store': 'stores',
  'api::brand.brand': 'brands',
  'api::bank.bank': 'banks',
  'api::category.category': 'categories',
};

export function isEntityTopPickUid(uid: string): uid is EntityTopPickUid {
  return ENTITY_TOP_PICK_UIDS.includes(uid as EntityTopPickUid);
}

export async function validateEntityTopPickCoupons(
  strapi: Core.Strapi,
  uid: EntityTopPickUid,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (
    !data ||
    typeof data !== 'object' ||
    !Object.prototype.hasOwnProperty.call(data, 'topPickCoupons')
  ) {
    return;
  }
  const incomingTopPickCoupons = Reflect.get(data, 'topPickCoupons');

  const current: unknown = documentId
    ? await strapi.documents(uid).findOne({
        documentId,
        fields: ['documentId'],
        populate: { topPickCoupons: { fields: ['documentId'] } },
      })
    : null;
  const populatedTopPickCoupons =
    current && typeof current === 'object'
      ? Reflect.get(current, 'topPickCoupons')
      : null;
  const currentTopPickCoupons = Array.isArray(populatedTopPickCoupons)
    ? populatedTopPickCoupons
    : [];
  const selections = resultingRelations(
    incomingTopPickCoupons,
    currentTopPickCoupons,
  );
  if (selections == null) return;
  const count = selections.length;

  if (count > ENTITY_TOP_PICK_COUPON_MAX) {
    const overBy = count - ENTITY_TOP_PICK_COUPON_MAX;
    reject(
      `Top Pick Coupons accepts at most ${ENTITY_TOP_PICK_COUPON_MAX} Coupons. ` +
        'Two are shown and two are buffered for expiry. ' +
        `Remove ${overBy} Coupon${overBy === 1 ? '' : 's'}.`,
    );
  }

  if (count === 0) return;

  if (!documentId) {
    reject(
      'Save this entity before selecting Top Pick Coupons so only its related Coupons can be chosen.',
    );
  }

  const documentIds = selections.flatMap((selection) => {
    if (typeof selection === 'string') return [selection];
    if (!selection || typeof selection !== 'object') return [];
    const value = Reflect.get(selection, 'documentId');
    return typeof value === 'string' && value ? [value] : [];
  });
  const numericIds = selections.flatMap((selection) => {
    if (typeof selection === 'number') return [selection];
    if (!selection || typeof selection !== 'object') return [];
    const value = Reflect.get(selection, 'id');
    return typeof value === 'number' ? [value] : [];
  });
  const identityFilters = [
    ...(documentIds.length > 0
      ? [{ documentId: { $in: [...new Set(documentIds)] } }]
      : []),
    ...(numericIds.length > 0
      ? [{ id: { $in: [...new Set(numericIds)] } }]
      : []),
  ];

  const eligibleCoupons: unknown = await strapi
    .documents('api::coupon.coupon')
    .findMany({
      filters: {
        $and: [
          identityFilters.length === 1
            ? identityFilters[0]
            : { $or: identityFilters },
          {
            [COUPON_RELATION_BY_UID[uid]]: { documentId },
          },
          publishedOnlyFilters(),
        ],
      },
      fields: ['documentId'],
      limit: ENTITY_TOP_PICK_COUPON_MAX,
    });
  const eligible = Array.isArray(eligibleCoupons) ? eligibleCoupons : [];
  const invalidSelections = selections.filter((selection) => {
    const selectedKeys = new Set(relationKeys(selection));
    return !eligible.some((coupon) =>
      relationKeys(coupon).some((key) => selectedKeys.has(key)),
    );
  });

  if (invalidSelections.length === 0) return;
  const label = uid.split('::')[1]?.split('.')[0] ?? 'entity';
  reject(
    `Top Pick Coupons must be published Coupons related to this ${label}. ` +
      `Remove ${invalidSelections.length} unrelated or unavailable Coupon` +
      `${invalidSelections.length === 1 ? '' : 's'}.`,
  );
}
