import { describe, expect, it, vi } from "vitest";

import createSearchController from "./search";

describe("search controller", () => {
  it("sends the policy-protected runtime status payload", () => {
    const status = {
      mode: "postgres-sql",
      pgTrgmAvailable: true,
      missingExpectedIndexes: [],
      invalidExpectedIndexes: [],
    };
    const service = { status: vi.fn(() => status) };
    const strapi = { service: vi.fn(() => service) };
    const send = vi.fn((payload) => payload);
    const set = vi.fn();
    const controller = createSearchController({ strapi: strapi as any });

    expect(controller.status({ send, set } as any)).toEqual(status);
    expect(strapi.service).toHaveBeenCalledWith("api::search.search");
    expect(service.status).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(send).toHaveBeenCalledWith(status);
  });
});
