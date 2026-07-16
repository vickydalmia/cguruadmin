import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { publishedOnlyFilters } from './content-status';
import {
  relationKeys,
  resultingRelations,
} from './deal-of-the-day-validation';

export const ENTITY_TOP_PICK_COUPON_MAX = 4;
export const ENTITY_TOP_PICK_COUPON_MIN = 2;

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
    const message =
      `Top Pick Coupons accepts at most ${ENTITY_TOP_PICK_COUPON_MAX} Coupons. ` +
      'Two are shown and two are buffered for expiry. ' +
      `Remove ${overBy} Coupon${overBy === 1 ? '' : 's'}.`;
    throw new errors.ValidationError(message, {
      errors: [
        {
          path: ['topPickCoupons'],
          message,
          name: 'ValidationError',
        },
      ],
      problems: [`topPickCoupons: ${message}`],
    });
  }

  if (count === 0) return;
  if (count < ENTITY_TOP_PICK_COUPON_MIN) {
    const message =
      `Select at least ${ENTITY_TOP_PICK_COUPON_MIN} Top Pick Coupons, ` +
      'or clear the selection to use the latest-two fallback.';
    throw new errors.ValidationError(message, {
      errors: [
        {
          path: ['topPickCoupons'],
          message,
          name: 'ValidationError',
        },
      ],
      problems: [`topPickCoupons: ${message}`],
    });
  }

  if (!documentId) {
    const message =
      'Save this entity before selecting Top Pick Coupons so only its related Coupons can be chosen.';
    throw new errors.ValidationError(message, {
      errors: [{ path: ['topPickCoupons'], message, name: 'ValidationError' }],
      problems: [`topPickCoupons: ${message}`],
    });
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
  const message =
    `Top Pick Coupons must be published Coupons related to this ${label}. ` +
    `Remove ${invalidSelections.length} unrelated or unavailable Coupon` +
    `${invalidSelections.length === 1 ? '' : 's'}.`;
  throw new errors.ValidationError(message, {
    errors: [{ path: ['topPickCoupons'], message, name: 'ValidationError' }],
    problems: [`topPickCoupons: ${message}`],
  });
}
