export function isValidAffiliateDestination(value: string | null | undefined): boolean {
  const raw = value?.trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

export function corruptedNoCodeReason(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^https?:\/\//iu.test(raw)) return "URL stored in Coupon code field";
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu.test(raw)) {
    return "image value stored in Coupon code field";
  }
  return null;
}
