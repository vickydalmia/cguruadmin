import type { Core } from '@strapi/strapi';

export const OFFER_ENTITY_TYPES = ['coupon', 'deal'] as const;
export type OfferEntityType = (typeof OFFER_ENTITY_TYPES)[number];

export const OFFER_FEEDBACK_VALUES = ['worked', 'failed'] as const;
export type OfferFeedbackValue = (typeof OFFER_FEEDBACK_VALUES)[number];

const POSTGRES_CLIENTS = ['pg', 'postgres', 'postgresql'];
const SQLITE_CLIENTS = ['sqlite', 'sqlite3', 'better-sqlite3'];

const OFFER_TABLES: Record<OfferEntityType, string> = {
  coupon: 'coupons',
  deal: 'deals',
};

function isUniqueViolation(err: any): boolean {
  return (
    err?.code === '23505' ||
    err?.errno === 1062 ||
    /UNIQUE constraint failed/i.test(String(err?.message ?? ''))
  );
}

export function isOfferEntityType(value: unknown): value is OfferEntityType {
  return OFFER_ENTITY_TYPES.includes(value as OfferEntityType);
}

export function isOfferFeedbackValue(
  value: unknown,
): value is OfferFeedbackValue {
  return OFFER_FEEDBACK_VALUES.includes(value as OfferFeedbackValue);
}

async function freshCounts(trx: any, table: string, id: number) {
  return await trx(table)
    .where({ id })
    .select(['worked_count', 'failed_count'])
    .first();
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  // Raw Knex on purpose: bypassing the document service keeps votes out of the
  // ISR outbox, so feedback never triggers page regeneration.
  async submitFeedback(
    entityType: OfferEntityType,
    documentId: string,
    value: OfferFeedbackValue,
    ipHash: string,
  ) {
    const table = OFFER_TABLES[entityType];
    const knex = strapi.db.connection;
    const client = String((knex as any)?.client?.config?.client ?? '').toLowerCase();
    const offer = await knex(table)
      .where({ document_id: documentId })
      .select(['id', 'document_id', 'worked_count', 'failed_count'])
      .first();
    if (!offer) return null;

    // COALESCE everywhere: Strapi schema sync may have created the counter
    // columns as nullable before the migration ran.
    const counterColumn = value === 'worked' ? 'worked_count' : 'failed_count';

    try {
      const counts = await knex.transaction(async (trx: any) => {
        await trx('offer_feedback_votes').insert({
          entity_type: entityType,
          entity_document_id: documentId,
          ip_hash: ipHash,
          value,
        });

        const update = trx(table)
          .where({ id: offer.id })
          .update({
            [counterColumn]: trx.raw(`COALESCE(${counterColumn}, 0) + 1`),
          });

        if (POSTGRES_CLIENTS.includes(client) || SQLITE_CLIENTS.includes(client)) {
          const rows = await update.returning(['worked_count', 'failed_count']);
          return rows?.[0] ?? null;
        }
        await update;
        return await freshCounts(trx, table, offer.id);
      });
      if (!counts) return null;
      return {
        workedCount: Number(counts.worked_count ?? 0),
        failedCount: Number(counts.failed_count ?? 0),
        alreadyVoted: false,
      };
    } catch (err: any) {
      if (!isUniqueViolation(err)) throw err;
      const current = await knex(table)
        .where({ id: offer.id })
        .select(['worked_count', 'failed_count'])
        .first();
      if (!current) return null;
      return {
        workedCount: Number(current.worked_count ?? 0),
        failedCount: Number(current.failed_count ?? 0),
        alreadyVoted: true,
      };
    }
  },
});
