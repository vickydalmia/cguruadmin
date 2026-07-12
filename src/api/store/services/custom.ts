import type { Core } from '@strapi/strapi';

// Raw Knex ON PURPOSE: rating votes must NOT go through strapi.documents —
// the global documents middleware in src/index.ts enqueues static rebuilds on
// every documents-API write, and anonymous votes must never trigger a rebuild.

const POSTGRES_CLIENTS = ['pg', 'postgres', 'postgresql'];
const SQLITE_CLIENTS = ['sqlite', 'sqlite3', 'better-sqlite3'];

function isUniqueViolation(err: any): boolean {
  return (
    err?.code === '23505' || // Postgres
    err?.errno === 1062 || // MySQL ER_DUP_ENTRY
    /UNIQUE constraint failed/i.test(String(err?.message ?? '')) // SQLite
  );
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  /**
   * Record one rating vote and return the fresh aggregate.
   * Returns null when no store matches the slug, and the current aggregate
   * with `alreadyVoted: true` when this client has voted on this store before
   * (enforced by the store_rating_votes UNIQUE constraint, so it survives
   * restarts and multi-node deploys).
   */
  async submitRating(slug: string, value: number, ipHash: string) {
    const knex = strapi.db.connection;
    const client: string = (knex as any)?.client?.config?.client ?? '';

    const store = await knex('stores')
      .where({ slug })
      .select(['id', 'rating_average', 'rating_count'])
      .first();
    if (!store) return null;

    // The vote row is the dedupe gate: only apply the aggregate update when
    // this insert actually lands. A concurrent duplicate loses on the unique
    // constraint and reports alreadyVoted instead of double-counting.
    try {
      await knex('store_rating_votes').insert({
        store_id: store.id,
        ip_hash: ipHash,
        value,
      });
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        return {
          ratingAverage: Number(store.rating_average ?? 0),
          ratingCount: Number(store.rating_count ?? 0),
          alreadyVoted: true,
        };
      }
      throw err;
    }

    // rating_average is assigned BEFORE rating_count: MySQL applies SET left to
    // right, Postgres reads old-row values — this order is correct on both.
    const update = knex('stores')
      .where({ id: store.id })
      .update({
        rating_average: knex.raw(
          'ROUND(((COALESCE(rating_average, 0) * COALESCE(rating_count, 0)) + ?) / (COALESCE(rating_count, 0) + 1.0), 2)',
          [value],
        ),
        rating_count: knex.raw('COALESCE(rating_count, 0) + 1'),
      });

    if (POSTGRES_CLIENTS.includes(client) || SQLITE_CLIENTS.includes(client)) {
      const rows = await update.returning(['rating_average', 'rating_count']);
      const row = rows?.[0];
      if (!row) return null;
      return {
        ratingAverage: Number(row.rating_average),
        ratingCount: Number(row.rating_count),
        alreadyVoted: false,
      };
    }

    // MySQL has no RETURNING: UPDATE yields the affected-row count, so read
    // the fresh values back.
    await update;
    const row = await knex('stores')
      .where({ id: store.id })
      .select(['rating_average', 'rating_count'])
      .first();
    if (!row) return null;
    return {
      ratingAverage: Number(row.rating_average),
      ratingCount: Number(row.rating_count),
      alreadyVoted: false,
    };
  },
});
