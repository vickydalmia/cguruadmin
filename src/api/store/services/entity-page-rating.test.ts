import { describe, expect, it } from 'vitest';
import createEntityPageService from './entity-page';

type Tables = Record<string, Array<Record<string, any>>>;

function cloneTables(tables: Tables): Tables {
  return Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      rows.map((row) => ({ ...row })),
    ]),
  );
}

function createKnex(initial: Tables) {
  const tables = cloneTables(initial);

  const createConnection = (data: Tables, commit?: () => void): any => {
    class Query {
      private filters: Record<string, any> = {};
      private selected: string[] | null = null;
      private updates: Record<string, any> | null = null;

      constructor(private table: string) {}

      where(filters: Record<string, any>) {
        this.filters = filters;
        return this;
      }

      select(fields: string[]) {
        this.selected = fields;
        return this;
      }

      private matches(row: Record<string, any>) {
        return Object.entries(this.filters).every(([key, value]) => row[key] === value);
      }

      private project(row: Record<string, any> | undefined) {
        if (!row || !this.selected) return row;
        return Object.fromEntries(this.selected.map((field) => [field, row[field]]));
      }

      async first() {
        return this.project((data[this.table] ?? []).find((row) => this.matches(row)));
      }

      async insert(input: Record<string, any>) {
        const rows = (data[this.table] ??= []);
        const duplicate = rows.some((row) => {
          if (this.table === 'entity_rating_votes') {
            return (
              row.entity_type === input.entity_type &&
              row.entity_document_id === input.entity_document_id &&
              row.ip_hash === input.ip_hash
            );
          }
          if (this.table === 'store_rating_votes') {
            return row.store_id === input.store_id && row.ip_hash === input.ip_hash;
          }
          return false;
        });
        if (duplicate) throw Object.assign(new Error('duplicate'), { code: '23505' });
        rows.push({ id: rows.length + 1, ...input });
        commit?.();
      }

      update(values: Record<string, any>) {
        this.updates = values;
        return this;
      }

      private applyUpdates() {
        const rows = (data[this.table] ?? []).filter((row) => this.matches(row));
        for (const row of rows) {
          const ratingValue = this.updates?.rating_average?.bindings?.[0];
          if (typeof ratingValue === 'number') {
            row.rating_average = Number(
              (
                ((Number(row.rating_average ?? 0) * Number(row.rating_count ?? 0)) +
                  ratingValue) /
                (Number(row.rating_count ?? 0) + 1)
              ).toFixed(2),
            );
          }
          if (this.updates?.rating_count) {
            row.rating_count = Number(row.rating_count ?? 0) + 1;
          }
        }
        commit?.();
        return rows;
      }

      async returning(fields: string[]) {
        this.selected = fields;
        return this.applyUpdates().map((row) => this.project(row));
      }
    }

    const connection = ((table: string) => new Query(table)) as any;
    connection.client = { config: { client: 'pg' } };
    connection.schema = {
      hasTable: async (table: string) => Object.hasOwn(data, table),
    };
    connection.raw = (sql: string, bindings: any[] = []) => ({ sql, bindings });
    connection.transaction = async (callback: (trx: any) => Promise<any>) => {
      const staged = cloneTables(data);
      const result = await callback(createConnection(staged));
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, staged);
      commit?.();
      return result;
    };
    return connection;
  };

  return { knex: createConnection(tables), tables };
}

describe('entity-page ratings', () => {
  it('writes and aggregates a Brand vote atomically, then deduplicates it', async () => {
    // Two locale rows of one document: the slug lookup pins the default
    // locale, the aggregate update must move BOTH rows (the knex write is
    // invisible to the i18n non-localized sync).
    const db = createKnex({
      brands: [
        {
          id: 1,
          document_id: 'brand-1',
          locale: 'en',
          slug: 'nike',
          rating_average: 4,
          rating_count: 2,
        },
        {
          id: 2,
          document_id: 'brand-1',
          locale: 'ar',
          slug: 'nike',
          rating_average: 4,
          rating_count: 2,
        },
      ],
      entity_rating_votes: [],
      store_rating_votes: [],
    });
    const service = createEntityPageService({
      strapi: { db: { connection: db.knex } } as any,
    });

    const first = await service.submitRating('brand', 'nike', 3, 'client-a');
    const duplicate = await service.submitRating('brand', 'nike', 3, 'client-a');

    expect(first).toEqual({
      ratingAverage: 3.67,
      ratingCount: 3,
      alreadyVoted: false,
    });
    expect(duplicate).toEqual({
      ratingAverage: 3.67,
      ratingCount: 3,
      alreadyVoted: true,
    });
    expect(db.tables.entity_rating_votes).toHaveLength(1);
    // Both locale rows of the document carry the new aggregate.
    expect(db.tables.brands.map((row) => row.rating_count)).toEqual([3, 3]);
  });

  it('dual-writes Store votes while the legacy table remains deployed', async () => {
    const db = createKnex({
      stores: [
        {
          id: 7,
          document_id: 'store-7',
          locale: 'en',
          slug: 'amazon',
          rating_average: 5,
          rating_count: 10,
        },
      ],
      entity_rating_votes: [],
      store_rating_votes: [],
    });
    const service = createEntityPageService({
      strapi: { db: { connection: db.knex } } as any,
    });

    const result = await service.submitRating('store', 'amazon', 4, 'client-b');

    expect(result).toEqual({
      ratingAverage: 4.91,
      ratingCount: 11,
      alreadyVoted: false,
    });
    expect(db.tables.entity_rating_votes[0]).toMatchObject({
      entity_type: 'store',
      entity_document_id: 'store-7',
      ip_hash: 'client-b',
      value: 4,
    });
    expect(db.tables.store_rating_votes[0]).toMatchObject({
      store_id: 7,
      ip_hash: 'client-b',
      value: 4,
    });
  });
});
