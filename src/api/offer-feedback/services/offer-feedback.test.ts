import { describe, expect, it } from 'vitest';
import createOfferFeedbackService from './offer-feedback';

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

  const createConnection = (data: Tables): any => {
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
        const duplicate = rows.some(
          (row) =>
            this.table === 'offer_feedback_votes' &&
            row.entity_type === input.entity_type &&
            row.entity_document_id === input.entity_document_id &&
            row.ip_hash === input.ip_hash,
        );
        if (duplicate) throw Object.assign(new Error('duplicate'), { code: '23505' });
        rows.push({ id: rows.length + 1, ...input });
      }

      update(values: Record<string, any>) {
        this.updates = values;
        return this;
      }

      private applyUpdates() {
        const rows = (data[this.table] ?? []).filter((row) => this.matches(row));
        for (const row of rows) {
          for (const column of ['worked_count', 'failed_count']) {
            if (this.updates?.[column]) {
              row[column] = Number(row[column] ?? 0) + 1;
            }
          }
        }
        return rows;
      }

      async returning(fields: string[]) {
        this.selected = fields;
        return this.applyUpdates().map((row) => this.project(row));
      }
    }

    const connection = ((table: string) => new Query(table)) as any;
    connection.client = { config: { client: 'pg' } };
    connection.raw = (sql: string, bindings: any[] = []) => ({ sql, bindings });
    connection.transaction = async (callback: (trx: any) => Promise<any>) => {
      const staged = cloneTables(data);
      const result = await callback(createConnection(staged));
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, staged);
      return result;
    };
    return connection;
  };

  return { knex: createConnection(tables), tables };
}

describe('offer-feedback service', () => {
  it('writes and counts a coupon vote atomically, then deduplicates it', async () => {
    // Two locale rows of one document: the read pins the default locale, the
    // counter update must move BOTH rows (the knex write is invisible to the
    // i18n non-localized sync).
    const db = createKnex({
      coupons: [
        {
          id: 1,
          document_id: 'coupon-1',
          locale: 'en',
          worked_count: 4,
          failed_count: 1,
        },
        {
          id: 2,
          document_id: 'coupon-1',
          locale: 'ar',
          worked_count: 4,
          failed_count: 1,
        },
      ],
      offer_feedback_votes: [],
    });
    const service = createOfferFeedbackService({
      strapi: { db: { connection: db.knex } } as any,
    });

    const first = await service.submitFeedback('coupon', 'coupon-1', 'worked', 'client-a');
    const duplicate = await service.submitFeedback('coupon', 'coupon-1', 'failed', 'client-a');

    expect(first).toEqual({
      workedCount: 5,
      failedCount: 1,
      alreadyVoted: false,
    });
    expect(duplicate).toEqual({
      workedCount: 5,
      failedCount: 1,
      alreadyVoted: true,
    });
    expect(db.tables.offer_feedback_votes).toHaveLength(1);
    expect(db.tables.offer_feedback_votes[0]).toMatchObject({
      entity_type: 'coupon',
      entity_document_id: 'coupon-1',
      ip_hash: 'client-a',
      value: 'worked',
    });
    // Both locale rows of the document moved in lockstep.
    expect(db.tables.coupons.map((row) => row.worked_count)).toEqual([5, 5]);
  });

  it('bumps the failed counter on deals and treats null counters as zero', async () => {
    const db = createKnex({
      deals: [
        {
          id: 9,
          document_id: 'deal-9',
          locale: 'en',
          worked_count: null,
          failed_count: null,
        },
      ],
      offer_feedback_votes: [],
    });
    const service = createOfferFeedbackService({
      strapi: { db: { connection: db.knex } } as any,
    });

    const result = await service.submitFeedback('deal', 'deal-9', 'failed', 'client-b');

    expect(result).toEqual({
      workedCount: 0,
      failedCount: 1,
      alreadyVoted: false,
    });
  });

  it('returns null for unknown offers without writing a vote', async () => {
    const db = createKnex({ coupons: [], offer_feedback_votes: [] });
    const service = createOfferFeedbackService({
      strapi: { db: { connection: db.knex } } as any,
    });

    const result = await service.submitFeedback('coupon', 'missing', 'worked', 'client-c');

    expect(result).toBeNull();
    expect(db.tables.offer_feedback_votes).toHaveLength(0);
  });
});
