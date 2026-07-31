import { createHmac, timingSafeEqual } from "node:crypto";
import { isTrustedSocket } from "../middlewares/rate-limit";

export const ISR_CACHE_BYPASS_HEADER = "x-cguru-isr-cache-bypass";
export const ISR_CACHE_BYPASS_MAX_AGE_MS = 10 * 60 * 1_000;

const TOKEN_VERSION = "v1";
const MAX_FUTURE_CLOCK_SKEW_MS = 60 * 1_000;
const TOKEN_MAX_LENGTH = 256;

/**
 * Verify the short-lived credential minted by the ISR gateway. The token is
 * intentionally bearer-like but time bounded; it authorizes only bypassing
 * the in-process response cache and grants no Strapi content permissions.
 */
export function verifyIsrCacheBypassToken(
  token: unknown,
  secret: string,
  nowMs = Date.now()
): boolean {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > TOKEN_MAX_LENGTH ||
    !Number.isSafeInteger(nowMs)
  ) {
    return false;
  }

  const normalizedSecret = secret.trim();
  if (!normalizedSecret) return false;

  const [version, timestampRaw, nonce, signature, extra] = token.split(".");
  if (
    extra !== undefined ||
    version !== TOKEN_VERSION ||
    !/^\d{10,16}$/.test(timestampRaw ?? "") ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(nonce ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature ?? "")
  ) {
    return false;
  }

  const timestampMs = Number(timestampRaw);
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) return false;
  const ageMs = nowMs - timestampMs;
  if (
    ageMs > ISR_CACHE_BYPASS_MAX_AGE_MS ||
    ageMs < -MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    return false;
  }

  const payload = `${version}.${timestampRaw}.${nonce}`;
  const expected = createHmac("sha256", normalizedSecret)
    .update(payload, "utf8")
    .digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);

/**
 * Network containment: even a validly signed token is honoured only when the
 * TCP connection itself originates inside the deployment — loopback (same
 * host: dev, container-to-container over a published loopback port) or the
 * RATE_LIMIT_TRUSTED_IPS socket allowlist (the UI droplet's VPC private IP,
 * matched on the raw socket address which, unlike X-Forwarded-For, cannot be
 * spoofed). A token that leaks past the VPC is therefore useless: the
 * attacker cannot open a socket that satisfies this check, because the DO
 * firewall blocks 1337/1338 from everywhere else and this guard rejects any
 * socket that is neither loopback nor allowlisted.
 */
function isVpcInternalSocket(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const ip = remoteAddress.replace(/^::ffff:/, "");
  return LOOPBACK_ADDRESSES.has(ip) || isTrustedSocket(remoteAddress);
}

export function hasAuthorizedIsrCacheBypass(ctx: any): boolean {
  if (!isVpcInternalSocket(ctx?.req?.socket?.remoteAddress)) return false;
  const secret = process.env.ISR_ADMIN_SECRET?.trim() ?? "";
  const token =
    typeof ctx?.get === "function"
      ? ctx.get(ISR_CACHE_BYPASS_HEADER)
      : ctx?.request?.headers?.[ISR_CACHE_BYPASS_HEADER];
  return verifyIsrCacheBypassToken(token, secret);
}
