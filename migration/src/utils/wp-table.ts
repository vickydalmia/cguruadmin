const SAFE_PREFIX = /^[A-Za-z0-9_]+$/u;
const SAFE_SUFFIX = /^[A-Za-z0-9_]+$/u;

export function validateWpTablePrefix(prefix: string): string {
  const normalized = prefix.trim();
  if (!normalized || !SAFE_PREFIX.test(normalized) || !normalized.endsWith("_")) {
    throw new Error(
      "WP_TABLE_PREFIX must contain only letters, numbers, and underscores and end with an underscore",
    );
  }
  return normalized;
}

export function wpTableName(prefix: string, suffix: string): string {
  const safePrefix = validateWpTablePrefix(prefix);
  if (!SAFE_SUFFIX.test(suffix)) {
    throw new Error(`Unsafe WordPress table suffix: ${suffix}`);
  }
  return `${safePrefix}${suffix}`;
}

/**
 * Compatibility boundary for the existing migration SQL. Every hardcoded
 * `wp_*` identifier is replaced immediately before MySQL sees the query, so
 * no phase can accidentally read the default-prefix tables on another source.
 */
export function rewriteWpTableNames(sql: string, prefix: string): string {
  const safePrefix = validateWpTablePrefix(prefix);
  if (safePrefix === "wp_") return sql;
  return sql.replace(/\bwp_([A-Za-z0-9_]+)\b/gu, (_match, suffix: string) =>
    wpTableName(safePrefix, suffix),
  );
}
