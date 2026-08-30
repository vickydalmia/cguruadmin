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
  'orderedCoupons',
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
 *
 * `trx` IS REQUIRED, AND IT MUST BE THE WRITE'S OWN TRANSACTION.
 *
 * This ran on `strapi.db.connection` — a fresh pool connection — and it
 * self-deadlocked. The caller invokes this from inside `runContentTransaction`,
 * after `executeWrite()` has already updated the entity row and taken its row
 * lock. A second connection updating that same row waits for the lock; the
 * transaction holding the lock waits for this function to return. Neither ever
 * moves, there is no timeout, and the save hangs forever — burning three
 * connections out of `pool.max` and holding the identity advisory lock, so
 * every later taxonomy save degrades to "proceeding unserialized" too. Three
 * such saves effectively wedge the instance until it is restarted.
 *
 * Passing the transaction is what makes the update part of the same lock
 * holder, so it simply proceeds. Kept as a required positional argument rather
 * than an option so it cannot be quietly dropped again — the failure mode is a
 * hang, which no test or error log would surface on its own.
 */
export async function touchEntityPageUpdatedAt(
  _strapi: Core.Strapi,
  trx: any,
  uid: EntityUid,
  result: unknown,
  documentId: string | undefined,
  now = new Date(),
): Promise<void> {
  if (typeof trx !== 'function') {
    throw new Error(
      'touchEntityPageUpdatedAt requires the write transaction — see the ' +
        'self-deadlock note above.',
    );
  }

  const table = ENTITY_TABLE_BY_UID[uid];

  // Touch EVERY locale row of the document, not just the written one. The
  // public page timestamp (sitemap lastmod, entity endpoints) must move for
  // the locale twins too, and this raw write is invisible to the i18n sync
  // that aligns non-localized fields on documents-API writes.
  if (documentId) {
    const updated = await trx(table)
      .where({ document_id: documentId })
      .update({ updated_at: now });
    if (Number(updated) < 1) {
      throw new Error(
        `Expected to touch at least one ${uid} row, updated ${String(updated)}`,
      );
    }
    return;
  }

  // Relation writes always address a document; a missing documentId leaves
  // only the written row's numeric id to go by.
  const id = Number((result as any)?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Could not resolve ${uid} row while touching entity-page updatedAt`);
  }

  const updated = await trx(table).where({ id }).update({ updated_at: now });
  if (Number(updated) !== 1) {
    throw new Error(`Expected to touch one ${uid} row, updated ${String(updated)}`);
  }
}
