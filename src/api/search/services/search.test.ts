import { describe, expect, it } from "vitest";

import createSearchService from "./search";

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
    },
    primaryStore: {
      name: "Shoe Store",
      slug: "shoe-store-coupons",
      logoAlt: "Shoe Store logo",
      logo: {
        url: "https://cdn.example.com/shoe-store.webp",
        width: 120,
        height: 60,
      },
    },
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

  return {
    calls,
    service: createSearchService({ strapi: strapi as any }),
  };
}

describe("public search entity boundaries", () => {
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
    expect(bankFind?.options.filters.$or).toContainEqual({
      slug: { $startsWithi: "sbi" },
    });
    expect(JSON.stringify(bankFind?.options.filters)).not.toContain(
      '"slug":{"$containsi"',
    );
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
    expect(storeFind?.options.filters).toEqual({
      $or: [{ name: { $containsi: "coupon" } }],
    });
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
    const filters = JSON.stringify(couponFind?.options.filters);
    expect(filters).toContain('"code"');
    expect(filters).toContain('"slug":{"$startsWithi":"fashion"}');
    expect(filters).not.toContain('"slug":{"$containsi"');
    expect(filters).not.toContain('"primaryStore"');
  });

  it("matches a product Deal through primaryStore name and slug", async () => {
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
    const filters = JSON.stringify(dealFind?.options.filters);
    expect(filters).toContain('"primaryStore"');
    expect(filters).toContain('"name"');
    expect(filters).toContain('"slug"');
  });
});
