import { describe, expect, it, vi } from "vitest";

import createSearchService, {
  configureSearchRuntime,
  EXPECTED_SEARCH_INDEXES,
  initializeSearchRuntime,
} from "./search";

function searchService() {
  const calls: Array<{ uid: string; operation: string; options: any }> = [];
  const coupon = {
    documentId: "coupon-no-code",
    title: "No-code fashion offer",
    code: null,
    couponType: "static",
    affiliateLink: "https://track.example.com/coupon",
    stores: [{ name: "Fashion Store", slug: "fashion-store-coupons" }],
  };
  const deal = {
    documentId: "product-deal",
    title: "Running shoes",
    affiliateLink: "https://track.example.com/shoes",
    salePrice: 1299,
    mrp: null,
    discount: "40% off",
    expiresAt: "2026-12-31T00:00:00.000Z",
    dealImage: {
      url: "https://cdn.example.com/shoes.webp",
      width: 600,
      height: 600,
      formats: {
        thumbnail: {
          url: "https://cdn.example.com/thumbnail_shoes.webp",
          width: 156,
        },
        xsmall: { url: "https://cdn.example.com/xsmall_shoes.webp", width: 320 },
        small: { url: "https://cdn.example.com/small_shoes.webp", width: 500 },
        original_avif: { url: "https://cdn.example.com/shoes.avif", width: 600 },
        xsmall_avif: {
          url: "https://cdn.example.com/xsmall_shoes.avif",
          width: 320,
        },
        small_avif: {
          url: "https://cdn.example.com/small_shoes.avif",
          width: 500,
        },
      },
    },
    // The owning store rides the `stores` taxonomy — `primaryStore` is gone,
    // and the WP migration folds its value into this same relation.
    stores: [
      {
        name: "Shoe Store",
        slug: "shoe-store-coupons",
        logoAlt: "Shoe Store logo",
        logo: {
          url: "https://cdn.example.com/shoe-store.webp",
          backgroundColour: "#e8edf4",
          width: 120,
          height: 60,
        },
      },
    ],
  };
  const bank = {
    documentId: "bank-sbi",
    name: "State Bank of India Card",
    slug: "sbi-card-coupons",
  };

  const strapi = {
    documents(uid: string) {
      return {
        async findMany(options: any) {
          calls.push({ uid, operation: "findMany", options });
          if (uid === "api::coupon.coupon") return [coupon];
          if (uid === "api::deal.deal") return [deal];
          if (uid === "api::bank.bank") return [bank];
          return [];
        },
        async count(options: any) {
          calls.push({ uid, operation: "count", options });
          if (uid === "api::coupon.coupon" || uid === "api::deal.deal") return 1;
          if (uid === "api::bank.bank") return 1;
          return 0;
        },
      };
    },
  };
  configureSearchRuntime(strapi as any);

  return {
    calls,
    service: createSearchService({ strapi: strapi as any }),
  };
}

function dealImageService(dealImage: Record<string, unknown>) {
  const deal = {
    documentId: "media-deal",
    title: "Media deal",
    affiliateLink: "https://track.example.com/media",
    salePrice: 100,
    dealImage,
  };
  const strapi = {
    documents(uid: string) {
      return {
        async findMany() {
          return uid === "api::deal.deal" ? [deal] : [];
        },
        async count() {
          return uid === "api::deal.deal" ? 1 : 0;
        },
      };
    },
  };
  configureSearchRuntime(strapi as any);
  return createSearchService({ strapi: strapi as any });
}

function categoryAltService() {
  const category = {
    documentId: "category-travel",
    name: "Travel",
    slug: "travel-coupons",
    iconAlt: "Suitcase and aeroplane",
    icon: {
      url: "https://cdn.example.com/travel.webp",
      width: 64,
      height: 64,
    },
  };
  const coupon = {
    documentId: "travel-coupon",
    title: "Travel coupon",
    couponType: "static",
    affiliateLink: "https://track.example.com/travel",
    categories: [category],
  };
  const strapi = {
    documents(uid: string) {
      return {
        async findMany() {
          if (uid === "api::category.category") return [category];
          if (uid === "api::coupon.coupon") return [coupon];
          return [];
        },
        async count() {
          return uid === "api::category.category" ||
            uid === "api::coupon.coupon"
            ? 1
            : 0;
        },
      };
    },
  };
  configureSearchRuntime(strapi as any);
  return createSearchService({ strapi: strapi as any });
}

describe("public search entity boundaries", () => {
  it("preserves category iconAlt in entity and category-owned offer media", async () => {
    const service = categoryAltService();
    const categoryResponse = await service.search({
      query: "travel",
      mode: "group",
      group: "categories",
      page: 1,
      pageSize: 20,
    });
    const couponResponse = await service.search({
      query: "travel",
      mode: "group",
      group: "coupons",
      page: 1,
      pageSize: 20,
    });

    expect(categoryResponse.categories[0].media.alt).toBe(
      "Suitcase and aeroplane",
    );
    expect(couponResponse.coupons[0].media.alt).toBe(
      "Suitcase and aeroplane",
    );
  });

  it("omits unsupported insights keys and rejects the insights group", async () => {
    const { service } = searchService();
    const response = await service.search({
      query: "fashion",
      mode: "preview",
      page: 1,
      pageSize: 20,
    });

    expect(response).not.toHaveProperty("insights");
    expect(response.totals).not.toHaveProperty("insights");
    expect(response.hasMore).not.toHaveProperty("insights");
    expect(
      service.parseRequest({ query: "fashion", group: "insights" }),
    ).toEqual({ ok: false, message: "A valid search group is required" });
  });

  it("rejects queries shorter than 3 characters (pg_trgm index floor)", () => {
    const { service } = searchService();
    expect(service.parseRequest({ query: "ta" })).toEqual({
      ok: false,
      message: "Search query must be between 3 and 80 characters",
    });
    expect(service.parseRequest({ query: "tat" })).toMatchObject({ ok: true });
  });

  it("keeps no-code Coupon records in the Coupon result group", async () => {
    const { calls, service } = searchService();
    const response = await service.search({
      query: "fashion",
      mode: "group",
      group: "coupons",
      page: 1,
      pageSize: 20,
    });

    expect(response.coupons).toHaveLength(1);
    expect(response.coupons[0]).toMatchObject({
      id: "coupon:coupon-no-code",
      type: "coupon",
      name: "No-code fashion offer",
    });
    const couponFind = calls.find(
      (call) => call.uid === "api::coupon.coupon" && call.operation === "findMany",
    );
    expect(JSON.stringify(couponFind?.options.filters)).not.toContain("couponType");
  });

  it("returns a product Deal without requiring MRP and includes owner metadata", async () => {
    const { calls, service } = searchService();
    const response = await service.search({
      query: "shoes",
      mode: "group",
      group: "deals",
      page: 1,
      pageSize: 20,
    });

    expect(response.deals).toHaveLength(1);
    expect(response.deals[0]).toMatchObject({
      id: "deal:product-deal",
      type: "deal",
      price: "1299",
      originalPrice: null,
      expiresAt: "2026-12-31T00:00:00.000Z",
      owner: {
        name: "Shoe Store",
        logo: {
          src: "https://cdn.example.com/shoe-store.webp",
          alt: "Shoe Store logo",
        },
      },
    });
    const dealFind = calls.find(
      (call) => call.uid === "api::deal.deal" && call.operation === "findMany",
    );
    expect(JSON.stringify(dealFind?.options.filters)).not.toContain('"mrp"');
    expect(dealFind?.options.fields).toContain("expiresAt");
  });

  it("splits media formats into a WebP srcset and an additive AVIF srcset", async () => {
    const { service } = searchService();
    const response = await service.search({
      query: "shoes",
      mode: "group",
      group: "deals",
      page: 1,
      pageSize: 20,
    });

    const media = response.deals[0].media;
    // WebP/fallback candidates only, width-sorted, xsmall rung included.
    expect(media.srcset).toBe(
      "https://cdn.example.com/thumbnail_shoes.webp 156w, " +
        "https://cdn.example.com/xsmall_shoes.webp 320w, " +
        "https://cdn.example.com/small_shoes.webp 500w",
    );
    expect(media.srcset).not.toContain(".avif");
    // AVIF twins land in their own srcset (same byWidth ordering).
    expect(media.avifSrcset).toBe(
      "https://cdn.example.com/xsmall_shoes.avif 320w, " +
        "https://cdn.example.com/small_shoes.avif 500w, " +
        "https://cdn.example.com/shoes.avif 600w",
    );
    // Media without formats (the owner logo) stays null on both fields.
    expect(response.deals[0].owner.logo.srcset).toBeNull();
    expect(response.deals[0].owner.logo.avifSrcset).toBeNull();
    expect(response.deals[0].owner.logo.backgroundColour).toBe("#E8EDF4");
  });

  it("suppresses avifSrcset when the twin ladder stops short of the fallback max", async () => {
    const service = dealImageService({
      url: "https://cdn.example.com/bag.webp",
      width: 960,
      height: 720,
      formats: {
        xsmall: { url: "https://cdn.example.com/xsmall_bag.webp", width: 320 },
        medium: { url: "https://cdn.example.com/medium_bag.webp", width: 750 },
        // Size guard dropped the medium twin — a 320w avif must not shadow a
        // 750w-capable fallback ladder for avif browsers.
        xsmall_avif: {
          url: "https://cdn.example.com/xsmall_bag.avif",
          width: 320,
        },
      },
    });
    const response = await service.search({
      query: "media",
      mode: "group",
      group: "deals",
      page: 1,
      pageSize: 20,
    });

    const media = response.deals[0].media;
    expect(media.srcset).toBe(
      "https://cdn.example.com/xsmall_bag.webp 320w, " +
        "https://cdn.example.com/medium_bag.webp 750w",
    );
    expect(media.avifSrcset).toBeNull();
  });

  it("keeps avifSrcset for twins-only media with no standard formats", async () => {
    const service = dealImageService({
      url: "https://cdn.example.com/bag.webp",
      width: 960,
      height: 720,
      formats: {
        xsmall_avif: {
          url: "https://cdn.example.com/xsmall_bag.avif",
          width: 320,
        },
      },
    });
    const response = await service.search({
      query: "media",
      mode: "group",
      group: "deals",
      page: 1,
      pageSize: 20,
    });

    const media = response.deals[0].media;
    expect(media.srcset).toBeNull();
    expect(media.avifSrcset).toBe(
      "https://cdn.example.com/xsmall_bag.avif 320w",
    );
  });

  it("matches entities by slug so acronym searches can find their full names", async () => {
    const { calls, service } = searchService();
    const response = await service.search({
      query: "sbi",
      mode: "group",
      group: "banks",
      page: 1,
      pageSize: 20,
    });

    expect(response.banks).toEqual([
      expect.objectContaining({
        id: "bank-sbi",
        type: "bank",
        name: "State Bank of India Card",
        link: "/sbi-card-coupons/",
      }),
    ]);
    const bankFind = calls.find(
      (call) => call.uid === "api::bank.bank" && call.operation === "findMany",
    );
    expect(bankFind?.options).toMatchObject({
      status: "published",
      filters: {},
      start: 0,
      limit: 500,
    });
  });

  it("does not search generic route suffixes as entity slugs", async () => {
    const { calls, service } = searchService();
    await service.search({
      query: "coupon",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });

    const storeFind = calls.find(
      (call) => call.uid === "api::store.store" && call.operation === "findMany",
    );
    expect(storeFind?.options.status).toBe("published");
    expect(storeFind?.options.filters).toEqual({});
    expect(JSON.stringify(storeFind?.options)).not.toContain("$containsi");
    expect(JSON.stringify(storeFind?.options)).not.toContain("$startsWithi");
  });

  it("searches Coupon codes and relation slugs without changing Coupon classification", async () => {
    const { calls, service } = searchService();
    await service.search({
      query: "fashion",
      mode: "group",
      group: "coupons",
      page: 1,
      pageSize: 20,
    });

    const couponFind = calls.find(
      (call) => call.uid === "api::coupon.coupon" && call.operation === "findMany",
    );
    expect(couponFind?.options.status).toBe("published");
    expect(couponFind?.options.fields).toContain("code");
    expect(couponFind?.options.populate).toHaveProperty("stores");
    expect(couponFind?.options.populate).not.toHaveProperty("primaryStore");
    expect(JSON.stringify(couponFind?.options.filters)).not.toContain(
      "$containsi",
    );
  });

  it("matches a product Deal through its store taxonomy name and slug", async () => {
    const { calls, service } = searchService();
    await service.search({
      query: "shoe",
      mode: "group",
      group: "deals",
      page: 1,
      pageSize: 20,
    });

    const dealFind = calls.find(
      (call) => call.uid === "api::deal.deal" && call.operation === "findMany",
    );
    expect(dealFind?.options.status).toBe("published");
    expect(dealFind?.options.populate).toHaveProperty("stores");
    expect(dealFind?.options.populate).not.toHaveProperty("primaryStore");
    expect(JSON.stringify(dealFind?.options.filters)).not.toContain("salePrice");
    expect(JSON.stringify(dealFind?.options.filters)).not.toContain("$containsi");
  });
});

function healthyIndexRow(
  indexname: string,
  opclassSchema = "public",
  tableSchema = "public",
): Record<string, unknown> {
  const [table, column] = indexname
    .replace(/_search_trgm_idx$/u, "")
    .split("_");
  return {
    indexname,
    expected_schema: tableSchema,
    table_schema: tableSchema,
    table_name: table,
    access_method: "gin",
    key_count: 1,
    expression:
      `translate((${column})::text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, ` +
      `'abcdefghijklmnopqrstuvwxyz'::text)`,
    opclass_name: "gin_trgm_ops",
    opclass_schema: opclassSchema,
    predicate: null,
    indisvalid: true,
    indisready: true,
  };
}

function rankedStrapi(options: {
  client: string;
  rows?: Array<Record<string, unknown>>;
  totals?: Record<string, number>;
  documents?: Record<string, any[]>;
  rawError?: Error;
  pgTrgmAvailable?: boolean;
  pgTrgmSchema?: string;
  presentIndexes?: string[];
  indexRows?: Array<Record<string, unknown>>;
  diagnosticsError?: Error;
  schemaResolutionError?: Error;
  tableSchema?: string;
  configuredSchema?: string;
}) {
  const calls: Array<{ uid: string; operation: string; options: any }> = [];
  const raw = vi.fn(async (sql: string, _bindings?: unknown[]) => {
    if (sql.includes("FROM pg_extension")) {
      return {
        rows: options.pgTrgmAvailable
          ? [{ schema_name: options.pgTrgmSchema ?? "public" }]
          : [],
      };
    }
    if (sql.includes("to_regclass")) {
      if (options.schemaResolutionError) throw options.schemaResolutionError;
      return { rows: [{ schema_name: options.tableSchema ?? "public" }] };
    }
    if (sql.includes("pg_index")) {
      if (options.diagnosticsError) throw options.diagnosticsError;
      return {
        rows:
          options.indexRows ??
          (options.presentIndexes ?? []).map((indexname) =>
            healthyIndexRow(
              indexname,
              options.pgTrgmSchema ?? "public",
              options.tableSchema ?? "public",
            ),
          ),
      };
    }
    if (options.rawError) throw options.rawError;
    if (sql.includes("count(*)")) {
      const table = Object.keys(options.totals ?? {}).find((name) =>
        sql.includes(`FROM ${name}`),
      );
      return { rows: [{ total: options.totals?.[table ?? ""] ?? 0 }] };
    }
    return { rows: options.rows ?? [] };
  });
  const warn = vi.fn();
  const error = vi.fn();
  const info = vi.fn();
  const strapi = {
    log: { warn, error, info },
    config: {
      get: vi.fn((key: string) =>
        key === "database.connection.connection.schema"
          ? options.configuredSchema
          : undefined,
      ),
    },
    db: {
      connection: {
        client: {
          config: {
            client: options.client,
            connection: options.configuredSchema
              ? { schema: options.configuredSchema }
              : undefined,
          },
        },
        raw,
      },
    },
    documents(uid: string) {
      return {
        async findMany(query: any) {
          calls.push({ uid, operation: "findMany", options: query });
          const documents = options.documents?.[uid] ?? [];
          if (typeof query?.start === "number") {
            return documents.slice(query.start, query.start + query.limit);
          }
          return documents;
        },
        async count(query: any) {
          calls.push({ uid, operation: "count", options: query });
          return 0;
        },
      };
    },
  };
  configureSearchRuntime(strapi as any);
  return {
    strapi,
    calls,
    raw,
    warn,
    error,
    info,
    service: createSearchService({ strapi: strapi as any }),
  };
}

describe("ranked SQL path (Postgres)", () => {
  it("pages ranked ids in SQL and hydrates them in ranked order", async () => {
    const storeA = { documentId: "store-a", name: "Alpha Boots", slug: "alpha-boots" };
    const storeB = { documentId: "store-b", name: "Boots", slug: "boots" };
    const { calls, raw, service } = rankedStrapi({
      client: "postgres",
      // SQL rank order: exact "Boots" first — hydration returns them swapped.
      rows: [
        { id: 2, document_id: "store-b" },
        { id: 1, document_id: "store-a" },
      ],
      totals: { stores: 40 },
      documents: { "api::store.store": [storeA, storeB] },
    });

    const response = await service.search({
      query: "boots",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });

    // Ranked page + count; there is no request-time capability probe.
    expect(raw).toHaveBeenCalledTimes(2);
    const [rankedSql, rankedBindings] = raw.mock.calls.find(([sql]) =>
      sql.includes("LIMIT ? OFFSET ?"),
    )!;
    expect(rankedSql).toContain("FROM stores");
    expect(rankedSql).toContain("LIMIT ? OFFSET ?");
    expect(rankedBindings.slice(-2)).toEqual([20, 0]);

    const hydrate = calls.find(
      (call) => call.uid === "api::store.store" && call.operation === "findMany",
    );
    // Hydration re-applies the published constraint so a row unpublished
    // between the ranked-ID query and this findMany is dropped, not served.
    expect(hydrate?.options.filters).toEqual({
      $and: [
        { documentId: { $in: ["store-b", "store-a"] } },
        { publishedAt: { $notNull: true } },
      ],
    });
    expect(hydrate?.options.populate).toEqual({ logo: true });

    // Response order follows the SQL ranking, not the hydration order.
    expect(response.stores.map((item: any) => item.id)).toEqual([
      "store-b",
      "store-a",
    ]);
    expect(response.totals.stores).toBe(40);
    expect(response.pagination).toMatchObject({ total: 40, pageCount: 2 });
    expect(response.hasMore.stores).toBe(true);
  });

  it("ranks offers in SQL and keeps the public offer shape", async () => {
    const coupon = {
      documentId: "coupon-1",
      title: "Fashion sale",
      code: "FASH10",
      couponType: "static",
      affiliateLink: "https://track.example.com/fashion",
      stores: [{ name: "Fashion Store", slug: "fashion-store" }],
    };
    const { calls, raw, service } = rankedStrapi({
      client: "pg",
      rows: [{ id: 7, document_id: "coupon-1" }],
      totals: { coupons: 1, deals: 0 },
      documents: { "api::coupon.coupon": [coupon] },
    });

    const response = await service.search({
      query: "fashion",
      mode: "group",
      group: "coupons",
      page: 1,
      pageSize: 20,
    });

    // Ranked page + coupon count + deal count (totals stay exact).
    expect(raw).toHaveBeenCalledTimes(3);
    // Hydration re-applies the contentStatus/expiresAt visibility so an
    // offer expiring between the two queries cannot be served.
    const hydrate = calls.find(
      (call) =>
        call.uid === "api::coupon.coupon" && call.operation === "findMany",
    );
    const hydrateFilters = JSON.stringify(hydrate?.options.filters);
    expect(hydrateFilters).toContain('"contentStatus"');
    expect(hydrateFilters).toContain('"expiresAt"');
    expect(response.coupons).toEqual([
      expect.objectContaining({ id: "coupon:coupon-1", type: "coupon" }),
    ]);
    expect(response.coupons[0]).not.toHaveProperty("rankFields");
    expect(response.totals).toMatchObject({ coupons: 1, deals: 0 });
  });

  it("uses one request cutoff for offer pages, counts, and hydration", async () => {
    const nowIso = "2026-07-20T12:34:56.789Z";
    const clock = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue(nowIso);
    try {
      const { calls, raw, service } = rankedStrapi({
        client: "postgres",
        rows: [{ id: 7, document_id: "coupon-1" }],
        totals: { coupons: 1, deals: 0 },
        documents: {
          "api::coupon.coupon": [
            { documentId: "coupon-1", title: "Fashion sale", stores: [] },
          ],
        },
      });

      await service.search({
        query: "fashion",
        mode: "group",
        group: "coupons",
        page: 1,
        pageSize: 20,
      });

      expect(clock).toHaveBeenCalledTimes(1);
      const offerSql = raw.mock.calls.filter(([sql]) =>
        /FROM (?:coupons|deals) o/u.test(sql),
      );
      expect(offerSql).toHaveLength(3);
      expect(offerSql.every(([, bindings]) => bindings?.[0] === nowIso)).toBe(
        true,
      );
      const hydrate = calls.find(
        ({ uid, operation }) =>
          uid === "api::coupon.coupon" && operation === "findMany",
      );
      expect(JSON.stringify(hydrate?.options.filters)).toContain(nowIso);
    } finally {
      clock.mockRestore();
    }
  });

  it("uses that same request cutoff for every fallback offer read", async () => {
    const nowIso = "2026-07-20T12:34:56.789Z";
    const clock = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue(nowIso);
    try {
      const { calls, service } = rankedStrapi({
        client: "sqlite",
        documents: {
          "api::coupon.coupon": [
            { documentId: "coupon-1", title: "Fashion sale", stores: [] },
          ],
          "api::deal.deal": [
            { documentId: "deal-1", title: "Fashion deal", salePrice: 10 },
          ],
        },
      });

      await service.search({
        query: "fashion",
        mode: "group",
        group: "coupons",
        page: 1,
        pageSize: 20,
      });

      expect(clock).toHaveBeenCalledTimes(1);
      const offerReads = calls.filter(
        ({ uid, operation }) =>
          operation === "findMany" &&
          (uid === "api::coupon.coupon" || uid === "api::deal.deal"),
      );
      expect(offerReads).toHaveLength(2);
      expect(
        offerReads.every(({ options }) =>
          JSON.stringify(options.filters).includes(nowIso),
        ),
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("over-fetches preview limits 7+2 (entities) and 3+2 (offers) in SQL", async () => {
    const { raw, service } = rankedStrapi({
      client: "postgres",
      rows: [],
      totals: {},
    });

    await service.search({
      query: "boots",
      mode: "preview",
      page: 1,
      pageSize: 20,
    });

    // 4 entities × (page + count) + 2 offers × (page + count).
    // Preview LIMITs carry the +2 null-backfill margin; display slicing
    // happens in JS after mapping.
    expect(raw).toHaveBeenCalledTimes(12);
    const pageLimits = raw.mock.calls
      .filter(([sql]) => sql.includes("LIMIT ? OFFSET ?"))
      .map(([, bindings]) => bindings[bindings.length - 2]);
    expect(pageLimits.sort()).toEqual([5, 5, 9, 9, 9, 9]);
  });

  it("runs no request-time capability probe", async () => {
    const { raw, service } = rankedStrapi({
      client: "postgres",
      rows: [],
      totals: {},
    });

    // Bootstrap already fixed the mode. Requests execute only page/count SQL;
    // extension and index diagnostics never run on the request path.
    await service.search({ query: "boots", mode: "preview", page: 1, pageSize: 20 });
    await service.search({
      query: "boots",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });
    expect(raw).toHaveBeenCalledTimes(14);
    for (const [sql] of raw.mock.calls) {
      expect(sql).not.toContain("pg_extension");
      expect(sql).not.toContain("similarity(");
    }
    const pageSqls = raw.mock.calls.filter(([sql]) =>
      sql.includes("LIMIT ? OFFSET ?"),
    );
    expect(pageSqls.length).toBeGreaterThan(0);
    for (const [sql] of pageSqls) expect(sql).not.toContain("similarity(");
  });

  it("backfills a null-mapping row so the ranked preview list stays full", async () => {
    const stores = Array.from({ length: 8 }, (_, index) => ({
      documentId: "store-" + (index + 1),
      name: "Boot Store " + (index + 1),
      slug: "boot-store-" + (index + 1),
    }));
    // An invalid slug makes mapEntity return null for the second-ranked row.
    stores[1].slug = "Bad Slug!";
    const { calls, service } = rankedStrapi({
      client: "postgres",
      rows: stores.map((store, index) => ({
        id: index + 1,
        document_id: store.documentId,
      })),
      totals: { stores: 8 },
      documents: { "api::store.store": stores },
    });

    const response = await service.search({
      query: "boot",
      mode: "preview",
      page: 1,
      pageSize: 20,
    });

    // The over-fetched candidate backfills the dropped row: still 7 items.
    expect(response.stores.map((item: any) => item.id)).toEqual([
      "store-1",
      "store-3",
      "store-4",
      "store-5",
      "store-6",
      "store-7",
      "store-8",
    ]);
    // Deal hydration re-applies contentStatus/expiry visibility alongside the
    // ranked ids without excluding Deals that omit optional pricing.
    const dealHydrate = calls.find(
      (call) => call.uid === "api::deal.deal" && call.operation === "findMany",
    );
    const dealFilters = JSON.stringify(dealHydrate?.options.filters);
    expect(dealFilters).toContain('"contentStatus"');
    expect(dealFilters).not.toContain('"salePrice"');
  });

  it("keeps the fallback preview list full when a row maps to null", async () => {
    const stores = Array.from({ length: 8 }, (_, index) => ({
      documentId: "store-" + (index + 1),
      name: "Boot Store " + (index + 1),
      slug: "boot-store-" + (index + 1),
    }));
    stores[1].slug = "Bad Slug!";
    const { raw, service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::store.store": stores },
    });

    const response = await service.search({
      query: "boot",
      mode: "preview",
      page: 1,
      pageSize: 20,
    });

    // Preview maps before slicing, so the null row backfills from the
    // full matching set instead of shrinking the list below 7.
    expect(raw).not.toHaveBeenCalled();
    expect(response.stores.map((item: any) => item.id)).toEqual([
      "store-1",
      "store-3",
      "store-4",
      "store-5",
      "store-6",
      "store-7",
      "store-8",
    ]);
  });

  it("stays on the query-engine path for non-Postgres clients", async () => {
    const { calls, raw, service } = rankedStrapi({ client: "sqlite" });

    await service.search({
      query: "boots",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });

    expect(raw).not.toHaveBeenCalled();
    const storeFind = calls.find(
      (call) => call.uid === "api::store.store" && call.operation === "findMany",
    );
    expect(storeFind?.options).toMatchObject({
      status: "published",
      filters: {},
      start: 0,
      limit: 500,
    });
    expect(JSON.stringify(storeFind?.options)).not.toContain("$containsi");
    expect(JSON.stringify(storeFind?.options)).not.toContain("$startsWithi");
  });

  it("reads, counts, ranks, and pages the full fallback set in 500-row batches", async () => {
    const stores = Array.from({ length: 501 }, (_, index) => {
      const suffix = String(index + 1).padStart(4, "0");
      return {
        documentId: `store-${suffix}`,
        name: `Boots ${suffix}`,
        slug: `boots-${suffix}`,
      };
    });
    const { calls, service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::store.store": stores },
    });

    const response = await service.search({
      query: "boots",
      mode: "group",
      group: "stores",
      page: 11,
      pageSize: 50,
    });

    expect(response.totals.stores).toBe(501);
    expect(response.pagination).toMatchObject({
      page: 11,
      pageSize: 50,
      pageCount: 11,
      total: 501,
    });
    expect(response.stores.map((item: any) => item.id)).toEqual([
      "store-0501",
    ]);
    const reads = calls.filter(
      (call) => call.uid === "api::store.store" && call.operation === "findMany",
    );
    // Page and total share one request-scoped full read: exactly two batches,
    // not separate scans for count and results.
    expect(reads.map(({ options }) => options.start)).toEqual([0, 500]);
    expect(reads.every(({ options }) => options.limit === 500)).toBe(true);
    expect(reads.every(({ options }) => options.status === "published")).toBe(
      true,
    );
  });

  it("treats %, _, and backslash literally in fallback membership", async () => {
    const stores = [
      {
        documentId: "literal",
        name: "Literal %_\\ Store",
        slug: "literal-store",
      },
      {
        documentId: "ordinary",
        name: "Ordinary Store",
        slug: "ordinary-store",
      },
    ];
    const { calls, service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::store.store": stores },
    });

    const response = await service.search({
      query: "%_\\",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });

    expect(response.totals.stores).toBe(1);
    expect(response.stores.map((item: any) => item.id)).toEqual(["literal"]);
    const read = calls.find(
      (call) => call.uid === "api::store.store" && call.operation === "findMany",
    );
    expect(JSON.stringify(read?.options)).not.toContain("$containsi");
    expect(JSON.stringify(read?.options)).not.toContain("$startsWithi");
  });

  it("reports bootstrap index diagnostics without changing Postgres SQL mode", async () => {
    const presentIndexes = [
      EXPECTED_SEARCH_INDEXES[0],
      EXPECTED_SEARCH_INDEXES[EXPECTED_SEARCH_INDEXES.length - 1],
    ];
    const { strapi, raw, service } = rankedStrapi({
      client: "postgres",
      pgTrgmAvailable: true,
      presentIndexes,
    });

    const status = await initializeSearchRuntime(strapi as any);
    expect(status).toEqual({
      mode: "postgres-sql",
      pgTrgmAvailable: true,
      missingExpectedIndexes: EXPECTED_SEARCH_INDEXES.filter(
        (name) => !presentIndexes.includes(name),
      ),
      invalidExpectedIndexes: [],
    });
    expect(service.status()).toEqual(status);
    expect(raw).toHaveBeenCalledTimes(3);
  });

  it("reports incorrect same-name indexes with actionable reasons", async () => {
    const name = EXPECTED_SEARCH_INDEXES[0];
    const { strapi, service } = rankedStrapi({
      client: "postgres",
      pgTrgmAvailable: true,
      indexRows: [
        {
          ...healthyIndexRow(name),
          table_name: "wrong_table",
          access_method: "btree",
          key_count: 2,
          expression: "upper(name)",
          opclass_name: "text_ops",
          opclass_schema: "wrong_schema",
          predicate: "name IS NOT NULL",
          indisvalid: false,
          indisready: false,
        },
      ],
    });

    const status = await initializeSearchRuntime(strapi as any);
    expect(status.mode).toBe("postgres-sql");
    expect(status.invalidExpectedIndexes).toHaveLength(1);
    expect(status.invalidExpectedIndexes[0]).toMatchObject({ name });
    expect(status.invalidExpectedIndexes[0].reason).toContain("wrong table");
    expect(status.invalidExpectedIndexes[0].reason).toContain("not GIN");
    expect(status.invalidExpectedIndexes[0].reason).toContain("wrong expression");
    expect(status.invalidExpectedIndexes[0].reason).toContain("not gin_trgm_ops");
    expect(status.invalidExpectedIndexes[0].reason).toContain("not valid");
    expect(status.invalidExpectedIndexes[0].reason).toContain("not ready");
    expect(status.missingExpectedIndexes).toHaveLength(
      EXPECTED_SEARCH_INDEXES.length - 1,
    );
    expect(service.status()).toEqual(status);
  });

  it("keeps PostgreSQL SQL mode when pg_trgm is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "test");
    try {
      const { strapi, calls, raw, warn, service } = rankedStrapi({
        client: "postgres",
        pgTrgmAvailable: false,
        presentIndexes: [...EXPECTED_SEARCH_INDEXES],
      });

      const status = await initializeSearchRuntime(strapi as any);
      expect(status).toEqual({
        mode: "postgres-sql",
        pgTrgmAvailable: false,
        missingExpectedIndexes: [],
        invalidExpectedIndexes: EXPECTED_SEARCH_INDEXES.map((name) => ({
          name,
          reason:
            "pg_trgm schema is unavailable; operator class is unverifiable",
        })),
      });
      expect(service.status()).toEqual(status);
      // Catalog inspection is diagnostic only and never changes mode.
      expect(raw).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("mode=postgres-sql");
      expect(warn.mock.calls[0][0]).toContain("retry on the next boot");

      await service.search({
        query: "boots",
        mode: "group",
        group: "stores",
        page: 1,
        pageSize: 20,
      });
      expect(
        raw.mock.calls.some(([sql]) => sql.includes("LIMIT ? OFFSET ?")),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.uid === "api::store.store" && call.operation === "findMany",
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("initializes once and logs a healthy Postgres status as info", async () => {
    const { strapi, raw, warn, error, info, service } = rankedStrapi({
      client: "postgres",
      pgTrgmAvailable: true,
      pgTrgmSchema: "extensions",
      presentIndexes: [...EXPECTED_SEARCH_INDEXES],
    });

    const first = await initializeSearchRuntime(strapi as any);
    const second = await initializeSearchRuntime(strapi as any);
    expect(second).toEqual(first);
    expect(service.status()).toEqual(first);
    expect(raw).toHaveBeenCalledTimes(3);
    expect(raw.mock.calls[0]?.[0]).toContain("FROM pg_extension");
    expect(raw.mock.calls[1]?.[0]).toContain("to_regclass");
    expect(raw.mock.calls[2]?.[0]).toContain(
      "pg_get_indexdef",
    );
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "[search] mode=postgres-sql pg_trgm=available missing_indexes=0 invalid_indexes=0",
    );
  });

  it("resolves and inspects indexes in the configured non-public schema", async () => {
    const { strapi, raw } = rankedStrapi({
      client: "postgres",
      configuredSchema: "tenant content",
      tableSchema: "tenant content",
      pgTrgmAvailable: true,
      pgTrgmSchema: "extensions",
      presentIndexes: [...EXPECTED_SEARCH_INDEXES],
    });

    await expect(initializeSearchRuntime(strapi as any)).resolves.toMatchObject({
      mode: "postgres-sql",
      missingExpectedIndexes: [],
      invalidExpectedIndexes: [],
    });

    const schemaCall = raw.mock.calls.find(([sql]) =>
      sql.includes("to_regclass"),
    )!;
    expect(schemaCall[0]).toContain("table_class.relkind IN ('r', 'p')");
    expect(schemaCall[1]?.[0]).toContain('"tenant content"."stores"');

    const indexCall = raw.mock.calls.find(([sql]) =>
      sql.includes("pg_get_indexdef"),
    )!;
    expect(indexCall[1]?.slice(0, 2)).toEqual([
      "tenant content",
      "tenant content",
    ]);
    expect(raw.mock.calls.every(([sql]) => !sql.includes("current_schema"))).toBe(
      true,
    );
  });

  it("keeps Postgres SQL mode when index inspection fails", async () => {
    vi.stubEnv("NODE_ENV", "test");
    try {
      const { strapi, calls, raw, warn, service } = rankedStrapi({
        client: "postgres",
        pgTrgmAvailable: true,
        diagnosticsError: new Error("permission denied for catalog"),
      });
      const status = await initializeSearchRuntime(strapi as any);
      // Indexes are performance aids only, so an uninspectable catalog never
      // changes the dialect-selected mode.
      expect(status).toEqual({
        mode: "postgres-sql",
        pgTrgmAvailable: true,
        missingExpectedIndexes: [...EXPECTED_SEARCH_INDEXES],
        invalidExpectedIndexes: [],
      });
      // One catalog failure plus the consolidated missing-performance warning.
      expect(warn).toHaveBeenCalledTimes(2);

      await service.search({
        query: "boots",
        mode: "group",
        group: "stores",
        page: 1,
        pageSize: 20,
      });
      expect(
        raw.mock.calls.some(([sql]) => sql.includes("LIMIT ? OFFSET ?")),
      ).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("initializes non-Postgres status without catalog queries", async () => {
    const { strapi, raw, service } = rankedStrapi({ client: "sqlite" });
    await expect(initializeSearchRuntime(strapi as any)).resolves.toEqual({
      mode: "query-engine",
      pgTrgmAvailable: false,
      missingExpectedIndexes: [],
      invalidExpectedIndexes: [],
    });
    expect(service.status().mode).toBe("query-engine");
    expect(raw).not.toHaveBeenCalled();
  });

  it("raises missing Postgres performance aids to an error in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { strapi, warn, error } = rankedStrapi({
        client: "postgres",
        pgTrgmAvailable: true,
        presentIndexes: [],
      });
      await initializeSearchRuntime(strapi as any);
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain("retry on the next boot");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports missing pg_trgm in production without changing SQL mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { strapi, warn, error, service } = rankedStrapi({
        client: "postgres",
        pgTrgmAvailable: false,
      });
      await initializeSearchRuntime(strapi as any);
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain("pg_trgm=missing");
      expect(error.mock.calls[0][0]).toContain("retry on the next boot");
      expect(service.status().mode).toBe("postgres-sql");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("raises diagnostic transport failures to errors in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { strapi, warn, error } = rankedStrapi({
        client: "postgres",
        pgTrgmAvailable: true,
        diagnosticsError: new Error("connection terminated"),
      });
      await initializeSearchRuntime(strapi as any);
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(2);
      expect(error.mock.calls[0][0]).toContain(
        "could not inspect expected indexes",
      );
      expect(error.mock.calls[1][0]).toContain("retry on the next boot");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("treats a Postgres SQL failure as a real error", async () => {
    const { calls, raw, error, service } = rankedStrapi({
      client: "postgres",
      rawError: new Error("Connection terminated unexpectedly"),
    });

    await expect(
      service.search({
        query: "boots",
        mode: "group",
        group: "stores",
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toThrow("Connection terminated unexpectedly");

    // The failure logs and propagates — no silent per-request switch to the
    // query-engine path (that would re-rank the window mid-pagination).
    expect(error).toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain("Postgres SQL failed");
    expect(calls).toHaveLength(0);

    // The mode stays Postgres SQL: the next search retries that path (and
    // surfaces the same error) instead of quietly downgrading.
    const attempts = raw.mock.calls.length;
    await expect(
      service.search({
        query: "boots",
        mode: "group",
        group: "stores",
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toThrow("Connection terminated unexpectedly");
    expect(raw.mock.calls.length).toBeGreaterThan(attempts);
  });
});

describe("fallback ranking alignment (query-engine mode)", () => {
  it("ranks raw offer fields before response whitespace cleanup", async () => {
    const coupons = [
      {
        documentId: "a-leading",
        title: " Boots",
        code: null,
        stores: [],
      },
      {
        documentId: "z-prefix",
        title: "Boots ",
        code: null,
        stores: [],
      },
    ];
    const { service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::coupon.coupon": coupons },
    });

    const response = await service.search({
      query: "boots",
      mode: "group",
      group: "coupons",
      page: 1,
      pageSize: 20,
    });

    // Raw "Boots " is a prefix hit (tier 1); raw " Boots" is only a word-
    // boundary hit (tier 2). Both map to the same cleaned public label, so
    // this would reverse by documentId if mapping happened before ranking.
    expect(response.coupons.map((item: any) => item.id)).toEqual([
      "coupon:z-prefix",
      "coupon:a-leading",
    ]);
    expect(response.coupons.map((item: any) => item.name)).toEqual([
      "Boots",
      "Boots",
    ]);
  });

  it("folds ASCII case but keeps non-ASCII characters exact-case", async () => {
    const stores = [
      { documentId: "exact-dotted", name: "İx Market", slug: "dotted-market" },
      { documentId: "plain-ascii", name: "ix Market", slug: "plain-market" },
      { documentId: "ascii-case", name: "NIKE Market", slug: "nike-market" },
    ];
    const { service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::store.store": stores },
    });

    const dotted = await service.search({
      query: "İX",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });
    expect(dotted.stores.map((item: any) => item.id)).toEqual([
      "exact-dotted",
    ]);

    const ascii = await service.search({
      query: "nike",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });
    expect(ascii.stores.map((item: any) => item.id)).toEqual(["ascii-case"]);
  });

  it("ranks a coupon code match as a direct tier-0 field", async () => {
    const coupons = [
      {
        documentId: "coupon-relation",
        title: "Extra savings bundle",
        code: null,
        stores: [{ name: "Fashion Store", slug: "fashion-store" }],
      },
      {
        documentId: "coupon-title",
        title: "Fashion sale",
        code: null,
        stores: [],
      },
      {
        documentId: "coupon-code",
        title: "Weekend special",
        code: "FASHION",
        stores: [],
      },
    ];
    const { raw, service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::coupon.coupon": coupons },
    });

    const response = await service.search({
      query: "fashion",
      mode: "group",
      group: "coupons",
      page: 1,
      pageSize: 20,
    });

    expect(raw).not.toHaveBeenCalled();
    // Mirrors the SQL tuple: code exact (tier 0) beats title prefix (tier 1)
    // beats relation-name prefix (tier 1 + 8).
    expect(response.coupons.map((item: any) => item.id)).toEqual([
      "coupon:coupon-code",
      "coupon:coupon-title",
      "coupon:coupon-relation",
    ]);
  });

  it("keeps relation-name matches strictly below every direct tier", async () => {
    const deals = [
      {
        documentId: "deal-relation",
        title: "Mega discount pack",
        salePrice: 10,
        // Relation-name EXACT match: tier 0 + 8 — still below any direct hit.
        stores: [{ name: "Boots", slug: "boots" }],
      },
      {
        documentId: "deal-title",
        title: "Winter boots offer",
        salePrice: 20,
      },
    ];
    const { service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::deal.deal": deals },
    });

    const response = await service.search({
      query: "boots",
      mode: "group",
      group: "deals",
      page: 1,
      pageSize: 20,
    });

    // Direct word-boundary tier 2 outranks relation-exact tier 8.
    expect(response.deals.map((item: any) => item.id)).toEqual([
      "deal:deal-title",
      "deal:deal-relation",
    ]);
  });

  it("breaks offer ties on normalized label then documentId", async () => {
    const coupons = [
      { documentId: "coupon-b", title: "Boots voucher", code: null, stores: [] },
      { documentId: "coupon-a", title: "Boots voucher", code: null, stores: [] },
      { documentId: "coupon-z", title: "boots deal", code: null, stores: [] },
    ];
    const { service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::coupon.coupon": coupons },
    });

    const response = await service.search({
      query: "boots",
      mode: "group",
      group: "coupons",
      page: 1,
      pageSize: 20,
    });

    // All prefix tier 1: case-normalized "boots deal" sorts before
    // "boots voucher"; equal labels fall through to documentId ASC.
    expect(response.coupons.map((item: any) => item.id)).toEqual([
      "coupon:coupon-z",
      "coupon:coupon-a",
      "coupon:coupon-b",
    ]);
  });

  it("breaks entity ties on name then documentId, not recency", async () => {
    const stores = [
      {
        documentId: "store-b",
        name: "Boots",
        slug: "boots-b",
        publishedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        documentId: "store-a",
        name: "Boots",
        slug: "boots-a",
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        documentId: "store-c",
        name: "Aero Boots",
        slug: "aero-boots",
        publishedAt: "2025-01-01T00:00:00.000Z",
      },
    ];
    const { service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::store.store": stores },
    });

    const response = await service.search({
      query: "boots",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });

    // Exact-name ties order by documentId ASC (recency no longer applies —
    // the SQL tuple has no date leg); word-boundary tier 2 sinks below.
    expect(response.stores.map((item: any) => item.id)).toEqual([
      "store-a",
      "store-b",
      "store-c",
    ]);
  });

  it("uses PostgreSQL C-equivalent UTF-8 byte ordering for fallback labels", async () => {
    const stores = [
      {
        documentId: "supplementary",
        name: "Boots \u{10000}",
        slug: "boots-supplementary",
      },
      {
        documentId: "private-use",
        name: "Boots \uE000",
        slug: "boots-private-use",
      },
    ];
    const { service } = rankedStrapi({
      client: "sqlite",
      documents: { "api::store.store": stores },
    });

    const response = await service.search({
      query: "boots",
      mode: "group",
      group: "stores",
      page: 1,
      pageSize: 20,
    });

    // UTF-8 starts U+E000 with EE and U+10000 with F0, so C collation puts
    // the private-use character first. JS UTF-16 `<` would reverse them.
    expect(response.stores.map((item: any) => item.id)).toEqual([
      "private-use",
      "supplementary",
    ]);
  });
});
