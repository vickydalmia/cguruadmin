import { describe, expect, it } from "vitest";

import routes from "./search";

describe("search routes", () => {
  it("keeps public search public and protects uncached status diagnostics", () => {
    const publicSearch = routes.routes.find(
      (route) => route.path === "/search",
    );
    const status = routes.routes.find(
      (route) => route.path === "/search/status",
    );

    expect(publicSearch?.config.auth).toBe(false);
    expect(status).toMatchObject({
      method: "GET",
      handler: "search.status",
      config: {
        auth: false,
        policies: ["global::search-status-auth"],
      },
    });
    expect(status?.config.middlewares).toBeUndefined();
  });
});
