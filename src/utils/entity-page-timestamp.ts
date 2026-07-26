import type { Core } from '@strapi/strapi';

const ENTITY_TABLE_BY_UID = {
  'api::store.store': 'stores',
  'api::brand.brand': 'brands',
  'api::category.category': 'categories',
  'api::bank.bank': 'banks',
} as const;

type EntityUid = keyof typeof ENTITY_TABLE_BY_UID;

const RENDERED_OFFER_RELATIONS = new Set([
  'coupons',
  'deals',
  'topPickCoupons',
]);

function isEntityUid(uid: string): uid is EntityUid {
  return Object.prototype.hasOwnProperty.call(ENTITY_TABLE_BY_UID, uid);
}

/**
 * Strapi can persist a mapped relation by changing only its link table. In
 * that case the entity row's updated_at is left untouched even though the
 * public entity page has changed.
 */
export function changesEntityOfferMembership(
  uid: string,
  data: unknown,
): uid is EntityUid {
  if (!isEntityUid(uid) || !data || typeof data !== 'object') return false;
  return [...RENDERED_OFFER_RELATIONS].some((field) =>
    Object.prototype.hasOwnProperty.call(data, field),
  );
}

/**
 * Touch the owning entity inside the current Strapi transaction after its
 * relation write succeeds. Raw Knex is intentional: a second Document Service
 * update would recurse through the global write middleware and enqueue a
 * duplicate ISR event.
 */
export async function touchEntityPageUpdatedAt(
  strapi: Core.Strapi,
  uid: EntityUid,
  result: unknown,
  documentId: string | undefined,
  now = new Date(),
): Promise<void> {
  let id = Number((result as any)?.id);

  if ((!Number.isSafeInteger(id) || id <= 0) && documentId) {
    const entity: any = await strapi.documents(uid).findOne({
      documentId,
      fields: ['documentId'] as any,
    });
    id = Number(entity?.id);
  }

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Could not resolve ${uid} row while touching entity-page updatedAt`);
  }

  const updated = await (strapi.db as any)
    .connection(ENTITY_TABLE_BY_UID[uid])
    .where({ id })
    .update({ updated_at: now });

  if (Number(updated) !== 1) {
    throw new Error(`Expected to touch one ${uid} row, updated ${String(updated)}`);
  }
}
