import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const {
  reconcileContentContractAfterSchemaSync,
} = require("../../database/content-contract-reconciliation.js");

type Row = Record<string, unknown>;

function fakeKnex(seed: Record<string, Row[]>) {
  const rows = structuredClone(seed);
  const columns = new Map(
    Object.entries(rows).map(([table, values]) => [
      table,
      new Set(values.flatMap((row) => Object.keys(row))),
    ]),
  );

  const knex: any = (table: string) => {
    const predicates: Array<(row: Row) => boolean> = [];
    const query: any = {
      whereNull(column: string) {
        predicates.push((row) => row[column] == null);
        return query;
      },
      whereNotNull(column: string) {
        predicates.push((row) => row[column] != null);
        return query;
      },
      where(callback: (builder: any) => void) {
        let blankColumn = "";
        const nested: any = {
          whereNull(column: string) {
            blankColumn = column;
            return nested;
          },
          orWhereRaw(_sql: string, bindings: string[]) {
            blankColumn = bindings[0];
            return nested;
          },
        };
        callback(nested);
        predicates.push(
          (row) =>
            row[blankColumn] == null ||
            String(row[blankColumn] ?? "").trim() === "",
        );
        return query;
      },
      whereRaw(_sql: string, bindings: string[]) {
        const column = bindings[0];
        predicates.push(
          (row) =>
            row[column] != null && String(row[column]).trim() !== "",
        );
        return query;
      },
      async update(values: Row) {
        let count = 0;
        for (const row of rows[table] ?? []) {
          if (!predicates.every((predicate) => predicate(row))) continue;
          for (const [column, value] of Object.entries(values)) {
            row[column] =
              typeof value === "object" &&
              value !== null &&
              "__ref" in value
                ? row[String((value as any).__ref)]
                : value;
          }
          count++;
        }
        return count;
      },
    };
    return query;
  };
  knex.schema = {
    hasTable: vi.fn(async (table: string) => table in rows),
    hasColumn: vi.fn(
      async (table: string, column: string) =>
        columns.get(table)?.has(column) ?? false,
    ),
  };
  knex.ref = (column: string) => ({ __ref: column });
  return { knex, rows, columns };
}

describe("post-schema content contract reconciliation", () => {
  it("fills only missing values and is idempotent", async () => {
    const { knex, rows } = fakeKnex({
      coupons: [
        { published_at: "2026-01-01", published_on: null },
        { published_at: "2026-01-02", published_on: "2026-02-01" },
      ],
      deals: [{ published_at: "2026-03-01", published_on: null }],
      stores: [{ name: "Amazon", logo_alt: "   " }],
      brands: [{ name: "Nike", logo_alt: "Authored Nike logo" }],
      banks: [{ name: "HDFC", logo_alt: null }],
      categories: [{ name: "Fashion", icon_alt: null }],
    });
    const logger = { info: vi.fn() };

    await expect(
      reconcileContentContractAfterSchemaSync(knex, logger),
    ).resolves.toEqual({ publishedOn: 2, mediaAlt: 3, couponType: 0 });
    expect(rows.coupons[0].published_on).toBe("2026-01-01");
    expect(rows.coupons[1].published_on).toBe("2026-02-01");
    expect(rows.brands[0].logo_alt).toBe("Authored Nike logo");
    expect(rows.categories[0].icon_alt).toBe("Fashion");

    await expect(
      reconcileContentContractAfterSchemaSync(knex, logger),
    ).resolves.toEqual({ publishedOn: 0, mediaAlt: 0, couponType: 0 });
  });

  it("retries after schema sync creates a previously absent column", async () => {
    const { knex, rows, columns } = fakeKnex({
      categories: [{ name: "Travel" }],
    });
    await expect(
      reconcileContentContractAfterSchemaSync(knex),
    ).resolves.toEqual({ publishedOn: 0, mediaAlt: 0, couponType: 0 });

    rows.categories[0].icon_alt = null;
    columns.get("categories")?.add("icon_alt");
    await expect(
      reconcileContentContractAfterSchemaSync(knex),
    ).resolves.toEqual({ publishedOn: 0, mediaAlt: 1, couponType: 0 });
    expect(rows.categories[0].icon_alt).toBe("Travel");
  });

  it("runs before search initialization in Strapi bootstrap", () => {
    const source = readFileSync(resolve(__dirname, "../index.ts"), "utf8");
    const bootstrap = source.slice(source.indexOf("async bootstrap"));
    expect(bootstrap).toContain("reconcileContentContractAfterSchemaSync(");
    expect(
      bootstrap.indexOf("reconcileContentContractAfterSchemaSync("),
    ).toBeLessThan(bootstrap.indexOf("initializeSearchRuntime(strapi)"));
  });
});

describe("coupon_type backfill", () => {
  it("fills NULL code types on existing offers without touching set ones", async () => {
    // Deals gained `coupon_type` when unique pools were extended to them, so
    // every pre-existing Deal row has it NULL. The public code rule is now
    // "expose `code` only for a known code type", so leaving them NULL would
    // silently stop every existing Deal from showing the code it has.
    const { knex, rows } = fakeKnex({
      coupons: [{ coupon_type: "unique", code: null }],
      deals: [
        { coupon_type: null, code: "SAVE20" },
        { coupon_type: null, code: null },
        { coupon_type: "unique", code: null },
      ],
    });

    await expect(
      reconcileContentContractAfterSchemaSync(knex, { info: vi.fn() }),
    ).resolves.toMatchObject({ couponType: 2 });

    expect(rows.deals.map((row) => row.coupon_type)).toEqual([
      "static",
      "static",
      "unique",
    ]);
    expect(rows.coupons[0].coupon_type).toBe("unique");
  });

  it("is a no-op before schema sync creates the column", async () => {
    const { knex, rows, columns } = fakeKnex({ deals: [{ code: "SAVE20" }] });

    await expect(
      reconcileContentContractAfterSchemaSync(knex, { info: vi.fn() }),
    ).resolves.toMatchObject({ couponType: 0 });

    rows.deals[0].coupon_type = null;
    columns.get("deals")?.add("coupon_type");
    await expect(
      reconcileContentContractAfterSchemaSync(knex, { info: vi.fn() }),
    ).resolves.toMatchObject({ couponType: 1 });
    expect(rows.deals[0].coupon_type).toBe("static");
  });
});
