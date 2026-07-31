import type { Core } from '@strapi/strapi';

import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { isContentManagerWrite } from './write-origin';
import { toValidationError } from './write-validation/problems';

export const OFFER_STORE_UIDS = [
  'api::coupon.coupon',
  'api::deal.deal',
] as const;

export type OfferStoreUid = (typeof OFFER_STORE_UIDS)[number];

export function isOfferStoreUid(uid: string): uid is OfferStoreUid {
  return OFFER_STORE_UIDS.includes(uid as OfferStoreUid);
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

// The document service also accepts shorthand relation values — a bare
// id/documentId, a single relation object, or null (clear all). Normalize
// them to the array form resultingRelations understands so a valid scripted
// CM write is not miscounted as zero Stores.
const normalizeRelationShorthand = (value: unknown): unknown => {
  if (value === null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [value];
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !hasOwn(value, 'set') &&
    !hasOwn(value, 'connect') &&
    !hasOwn(value, 'disconnect') &&
    relationKeys(value).length > 0
  ) {
    return [value];
  }
  return value;
};

const rejectStoreCount = (count: number): never => {
  const message =
    count === 0
      ? 'Select exactly one Store.'
      : `Exactly one Store is required. This entry currently has ${count} Stores; remove ${
          count - 1
        } before saving.`;
  throw toValidationError([{ path: ['stores'], message }]);
};

/**
 * Enforces the editor-only single-Store contract while leaving the schema and
 * every non-Content-Manager write path many-to-many compatible.
 *
 * Updates and clones resolve their relation command against the stored row.
 * Reading even when `stores` is absent is deliberate: an unrelated admin save
 * of a legacy multi-Store record must stop and ask the editor to clean it up.
 * For clone, `documentId` identifies the source document, so the same lookup
 * validates the relation set that Strapi will copy before merging clone data.
 */
export async function validateContentManagerOfferStore(
  strapi: Core.Strapi,
  uid: OfferStoreUid,
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

  let currentStores: RelationEntry[] = [];
  if ((action === 'update' || action === 'clone') && documentId) {
    const current: unknown = await strapi.documents(uid).findOne({
      documentId,
      fields: ['documentId'],
      populate: { stores: { fields: ['documentId'] } },
    });
    const populatedStores =
      current && typeof current === 'object'
        ? Reflect.get(current, 'stores')
        : undefined;
    currentStores = Array.isArray(populatedStores) ? populatedStores : [];
  }

  const incomingStores =
    data && typeof data === 'object' && hasOwn(data, 'stores')
      ? Reflect.get(data, 'stores')
      : undefined;
  const stores =
    incomingStores === undefined
      ? currentStores
      : resultingRelations(normalizeRelationShorthand(incomingStores), currentStores);
  const count = stores?.length ?? 0;

  if (count !== 1) rejectStoreCount(count);
}
