import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasAuthorizedIsrCacheBypass,
  ISR_CACHE_BYPASS_HEADER,
  ISR_CACHE_BYPASS_MAX_AGE_MS,
  verifyIsrCacheBypassToken,
} from "./isr-cache-bypass";

const SECRET = "shared-render-secret";
const NOW = 1_785_494_400_000;
const NONCE = "fixed_nonce_1234567890";

function signedToken(timestampMs = NOW): string {
  const payload = `v1.${timestampMs}.${NONCE}`;
  const signature = createHmac("sha256", SECRET)
    .update(payload, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

describe("ISR response-cache bypass token", () => {
  it("accepts a current gateway-signed token", () => {
    expect(verifyIsrCacheBypassToken(signedToken(), SECRET, NOW)).toBe(true);
  });

  it("rejects tampered, forged, expired, and far-future tokens", () => {
    const valid = signedToken();
    expect(verifyIsrCacheBypassToken(`${valid}x`, SECRET, NOW)).toBe(false);
    expect(verifyIsrCacheBypassToken(valid, "wrong-secret", NOW)).toBe(false);
    expect(
      verifyIsrCacheBypassToken(
        signedToken(NOW - ISR_CACHE_BYPASS_MAX_AGE_MS - 1),
        SECRET,
        NOW
      )
    ).toBe(false);
    expect(
      verifyIsrCacheBypassToken(signedToken(NOW + 60_001), SECRET, NOW)
    ).toBe(false);
  });

  it("fails closed for malformed input or a missing secret", () => {
    expect(verifyIsrCacheBypassToken(undefined, SECRET, NOW)).toBe(false);
    expect(verifyIsrCacheBypassToken("v1.bad.token", SECRET, NOW)).toBe(false);
    expect(verifyIsrCacheBypassToken(signedToken(), "", NOW)).toBe(false);
  });
});

describe("network containment of the bypass header", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  const ctxFrom = (remoteAddress: string | undefined) => ({
    req: { socket: { remoteAddress } },
    get: (name: string) =>
      name === ISR_CACHE_BYPASS_HEADER ? signedToken(Date.now()) : "",
  });

  it("honours a valid token only from loopback sockets", () => {
    vi.stubEnv("ISR_ADMIN_SECRET", SECRET);
    expect(hasAuthorizedIsrCacheBypass(ctxFrom("127.0.0.1"))).toBe(true);
    expect(hasAuthorizedIsrCacheBypass(ctxFrom("::1"))).toBe(true);
    expect(hasAuthorizedIsrCacheBypass(ctxFrom("::ffff:127.0.0.1"))).toBe(true);
  });

  it("rejects the same valid token from any external socket", () => {
    vi.stubEnv("ISR_ADMIN_SECRET", SECRET);
    // A leaked token is useless off-VPC: the raw socket address (which,
    // unlike X-Forwarded-For, cannot be spoofed) is neither loopback nor in
    // the RATE_LIMIT_TRUSTED_IPS allowlist.
    expect(hasAuthorizedIsrCacheBypass(ctxFrom("203.0.113.7"))).toBe(false);
    expect(hasAuthorizedIsrCacheBypass(ctxFrom("10.0.0.99"))).toBe(false);
    expect(hasAuthorizedIsrCacheBypass(ctxFrom(undefined))).toBe(false);
  });
});
