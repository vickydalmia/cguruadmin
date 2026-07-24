import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(digest(actual), digest(expected));
}

export default (
  policyContext: any,
  _config: unknown,
  { strapi }: { strapi: any },
): boolean => {
  const secret = process.env.ISR_ADMIN_SECRET?.trim();
  if (!secret) {
    strapi?.log?.error?.(
      "[search] /api/search/status denied: ISR_ADMIN_SECRET is not configured",
    );
    return false;
  }

  const header =
    typeof policyContext?.get === "function"
      ? policyContext.get("authorization")
      : policyContext?.request?.headers?.authorization;
  return constantTimeEqual(String(header ?? ""), `Bearer ${secret}`);
};
