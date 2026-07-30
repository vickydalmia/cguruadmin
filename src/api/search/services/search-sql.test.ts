import { describe, expect, it } from "vitest";

import {
  asciiFold,
  entityCountQuery,
  entityRankedQuery,
  escapeLike,
  isPostgresClient,
  offerCountQuery,
  offerRankedQuery,
  type SearchNeedles,
} from "./search-sql";

const NOW = "2026-07-19T00:00:00.000Z";

function needles(
  variants: string[],
  slugNeedles: string[] = [],
): SearchNeedles {
  return { variants, whereNeedles: [variants[variants.length - 1]], slugNeedles };
}

function placeholders(sql: string): number {
  return (sql.match(/\?/gu) ?? []).length;
}

describe("search-sql builders", () => {
  it("detects the Postgres client names and rejects others", () => {
    expect(isPostgresClient("pg")).toBe(true);
    expect(isPostgresClient("postgres")).toBe(true);
    expect(isPostgresClient("Postgresql")).toBe(true);
    expect(isPostgresClient("sqlite")).toBe(false);
    expect(isPostgresClient("better-sqlite3")).toBe(false);
    expect(isPostgresClient(undefined)).toBe(false);
  });

  it("escapes every LIKE metacharacter so user input matches literally", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("folds ASCII case only and preserves non-ASCII case exactly", () => {
    expect(asciiFold("NIKE İ É Ω")).toBe("nike İ É Ω");
  });

  it("ranks a literal needle exact > prefix > word-boundary > substring", () => {
    const query = entityRankedQuery(
      "stores",
      needles(["boots"], ["boots"]),
      { limit: 7, offset: 0 },
    );

    // WHERE first: name containment + slug prefix use the same deterministic
    // translate(A-Z, a-z) expression as their trigram indexes.
    expect(query.bindings.slice(0, 2)).toEqual(["%boots%", "boots%"]);
    // Tier CASE next, in ascending-tier pattern order (mirrors
    // relevanceForNeedle): exact, prefix, word-boundary, substring.
    expect(query.bindings.slice(2, 6)).toEqual([
      "boots",
      "boots%",
      "% boots%",
      "%boots%",
    ]);
    expect(query.sql).toMatch(
      /CASE WHEN translate\(name, '[A-Z]+', '[a-z]+'\) = \? THEN 0/u,
    );
    // Total order: tier, normalized label, documentId, then the exact page.
    // pg_trgm is deliberately absent from ordering semantics.
    expect(query.sql).toContain(
      `ASC, translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ` +
        `'abcdefghijklmnopqrstuvwxyz') COLLATE "C" ASC, ` +
        `document_id COLLATE "C" ASC LIMIT ? OFFSET ?`,
    );
    expect(query.bindings.slice(-2)).toEqual([7, 0]);
    expect(query.sql).not.toContain("similarity(");
    expect(query.sql).toContain("published_at IS NOT NULL");
  });

  it("folds multi-variant needles with LEAST and shifts derived variants +4", () => {
    const query = entityRankedQuery(
      "categories",
      { variants: ["Mobiles", "Mobile"], whereNeedles: ["Mobile"], slugNeedles: [] },
      { limit: 20, offset: 20 },
    );

    expect(query.sql).toContain("LEAST(CASE WHEN");
    // Derived variant tiers 4-7 stay strictly below every literal tier.
    expect(query.sql).toContain("THEN 4");
    expect(query.sql).toContain("THEN 7");
    // Needles are deterministically ASCII-folded into the tier bindings.
    expect(query.bindings).toContain("mobiles");
    expect(query.bindings).toContain("mobile");
    expect(query.bindings.slice(-2)).toEqual([20, 20]);
  });

  it("keeps malicious input out of the SQL text entirely", () => {
    const hostile = "'; drop table stores;--";
    const query = entityRankedQuery(
      "stores",
      { variants: [hostile], whereNeedles: [hostile], slugNeedles: [] },
      { limit: 7, offset: 0 },
    );

    expect(query.sql).not.toContain("drop");
    expect(query.sql).not.toContain(hostile);
    expect(query.bindings).toContain("%'; drop table stores;--%");

    const wildcards = entityRankedQuery(
      "stores",
      { variants: ["50%_off\\"], whereNeedles: ["50%_off\\"], slugNeedles: [] },
      { limit: 7, offset: 0 },
    );
    expect(wildcards.bindings[0]).toBe("%50\\%\\_off\\\\%");
    // Exact-match equality binding stays unescaped (no wildcards in =).
    expect(wildcards.bindings[1]).toBe("50%_off\\");
  });

  it("binds exactly one value per placeholder in every builder", () => {
    const multi = {
      variants: ["Watches", "Watch"],
      whereNeedles: ["Watch"],
      slugNeedles: ["watch"],
    };
    const queries = [
      entityRankedQuery("banks", multi, { limit: 20, offset: 40 }),
      entityCountQuery("banks", multi),
      offerRankedQuery("coupon", multi, { limit: 12, offset: 0 }, NOW),
      offerCountQuery("coupon", multi, NOW),
      offerRankedQuery("deal", multi, { limit: 12, offset: 24 }, NOW),
      offerCountQuery("deal", multi, NOW),
    ];
    for (const query of queries) {
      expect(query.bindings.length).toBe(placeholders(query.sql));
    }
  });

  it("searches coupons over title and code plus the four link tables", () => {
    const query = offerRankedQuery(
      "coupon",
      needles(["fashion"], ["fashion"]),
      { limit: 12, offset: 0 },
      NOW,
    );

    expect(query.sql).toContain("FROM coupons o");
    expect(query.sql).toContain("translate(o.title");
    expect(query.sql).toContain("translate(o.code");
    expect(query.sql).not.toContain("lower(");
    for (const link of [
      "coupons_stores_lnk",
      "coupons_brands_lnk",
      "coupons_categories_lnk",
      "coupons_banks_lnk",
    ]) {
      expect(query.sql).toContain(link);
    }
    expect(query.sql).not.toContain("primary_store");
    // Visibility mirrors publishedOnlyFilters, with the timestamp bound first.
    expect(query.sql).toContain("o.content_status = 'published'");
    expect(query.sql).toContain("(o.expires_at IS NULL OR o.expires_at > ?)");
    expect(query.bindings[0]).toBe(NOW);
    // Relation-name tiers rank below every direct tier.
    expect(query.sql).toContain("+ 8)");
    expect(query.sql).toContain(
      `translate(o.title, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ` +
        `'abcdefghijklmnopqrstuvwxyz') COLLATE "C" ASC, ` +
        `o.document_id COLLATE "C" ASC LIMIT ? OFFSET ?`,
    );
    expect(query.sql).not.toContain("similarity(");
  });

  it("allows price-less product deals and includes every taxonomy link", () => {
    const query = offerRankedQuery(
      "deal",
      needles(["shoes"], ["shoes"]),
      { limit: 12, offset: 0 },
      NOW,
    );

    expect(query.sql).toContain("FROM deals o");
    expect(query.sql).not.toContain("o.sale_price");
    // `primaryStore` is gone — its store is carried by the stores taxonomy.
    expect(query.sql).not.toContain("deals_primary_store_lnk");
    expect(query.sql).not.toContain("translate(o.code");
    for (const link of [
      "deals_stores_lnk",
      "deals_brands_lnk",
      "deals_categories_lnk",
      "deals_banks_lnk",
    ]) {
      expect(query.sql).toContain(link);
    }
  });

  it("binds the deal ranked query in exact placeholder order", () => {
    const query = offerRankedQuery(
      "deal",
      {
        variants: ["Watches", "Watch"],
        whereNeedles: ["Watch"],
        slugNeedles: ["watch"],
      },
      { limit: 12, offset: 24 },
      NOW,
    );

    // One [name-contains, slug-prefix] pair per link table, in declaration
    // order: stores, brands, categories, banks.
    const relationWhere = ["%watch%", "watch%"];
    // Literal variant tiers 0-3 then the derived variant shifted +4, each in
    // exact/prefix/word-boundary/substring pattern order.
    const nameTier = [
      "watches",
      "watches%",
      "% watches%",
      "%watches%",
      "watch",
      "watch%",
      "% watch%",
      "%watch%",
    ];
    // The full ordered array: any transposition against the placeholder
    // sequence fails loudly instead of silently binding the wrong value.
    expect(query.bindings).toEqual([
      NOW, // WHERE: expires_at visibility cutoff binds first
      "%watch%", // WHERE: title containment
      ...relationWhere, // WHERE: stores link
      ...relationWhere, // WHERE: brands link
      ...relationWhere, // WHERE: categories link
      ...relationWhere, // WHERE: banks link
      ...nameTier, // ORDER BY: direct title tier
      ...nameTier, // ORDER BY: stores name tier
      ...nameTier, // ORDER BY: brands name tier
      ...nameTier, // ORDER BY: categories name tier
      ...nameTier, // ORDER BY: banks name tier
      12, // LIMIT
      24, // OFFSET
    ]);
  });

  it("keeps dotted-I exact and never introduces locale-dependent lower()", () => {
    const query = entityRankedQuery(
      "stores",
      { variants: ["İX"], whereNeedles: ["İX"], slugNeedles: [] },
      { limit: 7, offset: 0 },
    );

    expect(query.sql).toContain(
      "translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') LIKE ?",
    );
    expect(query.sql).not.toContain("lower(");
    expect(query.bindings[0]).toBe("%İx%");
    expect(query.bindings[1]).toBe("İx");
    expect(query.bindings.length).toBe(placeholders(query.sql));
  });

  it("counts with the exact WHERE clause of the ranked page query", () => {
    const shared = needles(["fashion"], ["fashion"]);
    for (const [ranked, count] of [
      [
        entityRankedQuery("stores", shared, { limit: 20, offset: 0 }),
        entityCountQuery("stores", shared),
      ],
      [
        offerRankedQuery("coupon", shared, { limit: 20, offset: 0 }, NOW),
        offerCountQuery("coupon", shared, NOW),
      ],
      [
        offerRankedQuery("deal", shared, { limit: 20, offset: 0 }, NOW),
        offerCountQuery("deal", shared, NOW),
      ],
    ] as const) {
      const rankedWhere = ranked.sql.slice(
        ranked.sql.indexOf("WHERE"),
        ranked.sql.indexOf(" ORDER BY"),
      );
      const countWhere = count.sql.slice(count.sql.indexOf("WHERE"));
      expect(countWhere).toBe(rankedWhere);
      expect(ranked.bindings.slice(0, count.bindings.length)).toEqual(
        count.bindings,
      );
    }
  });
});
