import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cacheMiddleware from "./cache";
import { ISR_CACHE_BYPASS_HEADER } from "../utils/isr-cache-bypass";

const SECRET = "shared-render-secret";
const NONCE = "fixed_nonce_1234567890";
const originalSecret = process.env.ISR_ADMIN_SECRET;

function signedToken(timestampMs = Date.now()): string {
  const payload = `v1.${timestampMs}.${NONCE}`;
  const signature = createHmac("sha256", SECRET)
    .update(payload, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

function requestContext(token?: string, remoteAddress = "127.0.0.1") {
  const responseHeaders = new Map<string, string>();
  const requestHeaders = new Map<string, string>();
  if (token) requestHeaders.set(ISR_CACHE_BYPASS_HEADER, token);
  return {
    method: "GET",
    path: "/api/deal-of-the-day-full",
    originalUrl: "/api/deal-of-the-day-full",
    query: {},
    status: 200,
    body: undefined as unknown,
    // The bypass is honoured only for sockets that originate inside the
    // deployment (loopback or the RATE_LIMIT_TRUSTED_IPS allowlist).
    req: { socket: { remoteAddress } },
    get(name: string) {
      return requestHeaders.get(name.toLowerCase()) ?? "";
    },
    set(name: string, value: string) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    responseHeader(name: string) {
      return responseHeaders.get(name.toLowerCase());
    },
  };
}

describe("response cache ISR bypass", () => {
  beforeEach(() => {
    vi.stubEnv("ISR_ADMIN_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalSecret === undefined) delete process.env.ISR_ADMIN_SECRET;
    else process.env.ISR_ADMIN_SECRET = originalSecret;
  });

  it("reads fresh data without replacing the normal cached response", async () => {
    const middleware = cacheMiddleware(
      { ttlMs: 60_000, keyByPath: true },
      { strapi: {} as any }
    );

    const first = requestContext();
    await middleware(first, async () => {
      first.body = { title: "old Deal title" };
    });
    expect(first.responseHeader("x-cache")).toBe("MISS");

    const bypass = requestContext(signedToken());
    await middleware(bypass, async () => {
      bypass.body = { title: "updated Deal title" };
    });
    expect(bypass.body).toEqual({ title: "updated Deal title" });
    expect(bypass.responseHeader("x-cache")).toBe("BYPASS");

    const next = vi.fn();
    const normalHit = requestContext();
    await middleware(normalHit, next);
    expect(next).not.toHaveBeenCalled();
    expect(normalHit.body).toEqual({ title: "old Deal title" });
    expect(normalHit.responseHeader("x-cache")).toBe("HIT");
  });

  it("does not let invalid or expired credentials bypass a cached response", async () => {
    const middleware = cacheMiddleware(
      { ttlMs: 60_000, keyByPath: true },
      { strapi: {} as any }
    );
    const first = requestContext();
    await middleware(first, async () => {
      first.body = { title: "cached" };
    });

    for (const token of [
      "forged",
      signedToken(Date.now() - 10 * 60 * 1_000 - 1),
    ]) {
      const next = vi.fn();
      const ctx = requestContext(token);
      await middleware(ctx, next);
      expect(next).not.toHaveBeenCalled();
      expect(ctx.body).toEqual({ title: "cached" });
      expect(ctx.responseHeader("x-cache")).toBe("HIT");
    }
  });

  it("ignores a validly signed credential arriving over an external socket", async () => {
    const middleware = cacheMiddleware(
      { ttlMs: 60_000, keyByPath: true },
      { strapi: {} as any }
    );
    const first = requestContext();
    await middleware(first, async () => {
      first.body = { title: "cached" };
    });

    // A leaked token cannot be replayed from outside the VPC: the raw TCP
    // socket address is neither loopback nor allowlisted, and unlike
    // X-Forwarded-For it cannot be spoofed.
    const next = vi.fn();
    const external = requestContext(signedToken(), "203.0.113.7");
    await middleware(external, next);
    expect(next).not.toHaveBeenCalled();
    expect(external.body).toEqual({ title: "cached" });
    expect(external.responseHeader("x-cache")).toBe("HIT");
  });
});
