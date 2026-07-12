export function parseDecimal(value: string | null | undefined): number | null {
  if (!value) return null;

  // WordPress deal metadata contains both plain decimals and display-formatted
  // Indian prices (for example `2,899`, `₹17,499.00`, and `Rs. 17,499/-`).
  // parseFloat stops at the first comma and silently turns those into 2 or 17,
  // so normalize only the known presentation characters before validating the
  // complete value.
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/^(?:₹|inr|rs\.?)\s*/iu, "")
    .replace(/\/-\s*$/u, "")
    .replace(/,/gu, "")
    .trim();

  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseInteger(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}
