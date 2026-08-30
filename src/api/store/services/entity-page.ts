import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';

export const ENTITY_PAGE_TYPES = ['store', 'brand', 'category', 'bank'] as const;
export type EntityPageType = (typeof ENTITY_PAGE_TYPES)[number];

const POSTGRES_CLIENTS = ['pg', 'postgres', 'postgresql'];
const SQLITE_CLIENTS = ['sqlite', 'sqlite3', 'better-sqlite3'];

const ENTITY_TABLES: Record<EntityPageType, string> = {
  store: 'stores',
  brand: 'brands',
  category: 'categories',
  bank: 'banks',
};

function isUniqueViolation(err: any): boolean {
  return (
    err?.code === '23505' ||
    err?.errno === 1062 ||
    /UNIQUE constraint failed/i.test(String(err?.message ?? ''))
  );
}

export function isEntityPageType(value: unknown): value is EntityPageType {
  return ENTITY_PAGE_TYPES.includes(value as EntityPageType);
}

async function freshAggregate(trx: any, table: string, id: number) {
  return await trx(table)
    .where({ id })
    .select(['rating_average', 'rating_count'])
    .first();
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async submitRating(
    entityType: EntityPageType,
    slug: string,
    value: number,
    ipHash: string,
  ) {
    const table = ENTITY_TABLES[entityType];
    const knex = strapi.db.connection;
    const client = String((knex as any)?.client?.config?.client ?? '').toLowerCase();
    // The slug is shared by every locale row of the document, so pin the
    // lookup to the default locale for a deterministic row. The aggregate
    // UPDATE below then moves ALL locale rows of the document together —
    // ratings are shared data, and this knex write is invisible to the i18n
    // sync that keeps non-localized fields aligned on documents-API writes.
    const entity = await knex(table)
      .where({ slug, locale: DEFAULT_CONTENT_LOCALE })
      .select(['id', 'document_id', 'rating_average', 'rating_count'])
      .first();
    if (!entity) return null;

    const entityDocumentId = String(entity.document_id ?? `id:${entity.id}`);
    const documentWhere = entity.document_id
      ? { document_id: entity.document_id }
      : { id: entity.id };
    const dualWriteStore =
      entityType === 'store' &&
      (await knex.schema.hasTable('store_rating_votes'));

    try {
      const aggregate = await knex.transaction(async (trx: any) => {
        await trx('entity_rating_votes').insert({
          entity_type: entityType,
          entity_document_id: entityDocumentId,
          ip_hash: ipHash,
          value,
        });
        if (dualWriteStore) {
          await trx('store_rating_votes').insert({
            store_id: entity.id,
            ip_hash: ipHash,
            value,
          });
        }

        // Per-row arithmetic over every locale row of the document: each row
        // folds the vote into its own aggregate, so twins stay in lockstep.
        const update = trx(table)
          .where(documentWhere)
          .update({
            rating_average: trx.raw(
              'ROUND(((COALESCE(rating_average, 0) * COALESCE(rating_count, 0)) + ?) / (COALESCE(rating_count, 0) + 1.0), 2)',
              [value],
            ),
            rating_count: trx.raw('COALESCE(rating_count, 0) + 1'),
          });

        if (POSTGRES_CLIENTS.includes(client) || SQLITE_CLIENTS.includes(client)) {
          const rows = await update.returning(['rating_average', 'rating_count']);
          return rows?.[0] ?? null;
        }
        await update;
        return await freshAggregate(trx, table, entity.id);
      });
      if (!aggregate) return null;
      return {
        ratingAverage: Number(aggregate.rating_average),
        ratingCount: Number(aggregate.rating_count),
        alreadyVoted: false,
      };
    } catch (err: any) {
      if (!isUniqueViolation(err)) throw err;
      const current = await knex(table)
        .where({ id: entity.id })
        .select(['rating_average', 'rating_count'])
        .first();
      if (!current) return null;
      return {
        ratingAverage: Number(current.rating_average ?? 0),
        ratingCount: Number(current.rating_count ?? 0),
        alreadyVoted: true,
      };
    }
  },
});
