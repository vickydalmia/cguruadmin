import { afterEach, describe, expect, it, vi } from "vitest";

import searchStatusAuth from "./search-status-auth";

function context(authorization?: string) {
  return { get: vi.fn(() => authorization ?? "") };
}

describe("search status authorization policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed when ISR_REVALIDATE_SECRET is missing", () => {
    vi.stubEnv("ISR_REVALIDATE_SECRET", "");
    const error = vi.fn();
    expect(
      searchStatusAuth(context(), {}, { strapi: { log: { error } } }),
    ).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("ISR_REVALIDATE_SECRET is not configured"),
    );
  });

  it.each([
    undefined,
    "wrong-secret",
    "Bearer wrong-secret",
    "bearer test-secret",
    "Bearer test-secret extra",
  ])("rejects a missing or malformed bearer value: %s", (authorization) => {
    vi.stubEnv("ISR_REVALIDATE_SECRET", "test-secret");
    expect(
      searchStatusAuth(context(authorization), {}, { strapi: {} }),
    ).toBe(false);
  });

  it("accepts only the exact Bearer secret", () => {
    vi.stubEnv("ISR_REVALIDATE_SECRET", "test-secret");
    expect(
      searchStatusAuth(context("Bearer test-secret"), {}, { strapi: {} }),
    ).toBe(true);
  });
});
