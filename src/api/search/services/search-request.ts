// Search REQUEST PARSING: query/page/group normalisation and limits.
// One of the modules split out of the search service (see ./search.ts).

// 3 is a hard floor for performance, not taste: pg_trgm needs a full
// trigram, so an unanchored LIKE '%xx%' with a 2-char needle can never use
// the GIN indexes and every membership arm seq-scans (observed ~2s previews).
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 80;

export const MAX_PAGE = 20;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export const GROUPS = [
  "stores",
  "brands",
  "categories",
  "banks",
  "coupons",
  "deals",
] as const;

export type SearchGroup = (typeof GROUPS)[number];

export type SearchRequest = {
  query: string;
  mode: "preview" | "group";
  group?: SearchGroup;
  page: number;
  pageSize: number;
};

export function oneString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function positiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const raw = oneString(value);
  if (!raw || !/^\d+$/u.test(raw)) return fallback;
  return Math.max(1, Math.min(Number(raw), max));
}

export function parseRequest(raw: Record<string, unknown>) {
  const allowed = new Set(["query", "mode", "group", "page", "pageSize"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    return { ok: false as const, message: "Unsupported search parameter" };
  }

  const rawQuery = oneString(raw.query);
  if (rawQuery === null) {
    return { ok: false as const, message: "Search query must be a string" };
  }

  const query = normalizeQuery(rawQuery);
  const length = Array.from(query).length;
  if (length < MIN_QUERY_LENGTH || length > MAX_QUERY_LENGTH) {
    return {
      ok: false as const,
      message: `Search query must be between ${MIN_QUERY_LENGTH} and ${MAX_QUERY_LENGTH} characters`,
    };
  }

  const requestedMode = oneString(raw.mode);
  if (
    requestedMode !== null &&
    requestedMode !== "preview" &&
    requestedMode !== "group"
  ) {
    return { ok: false as const, message: "Invalid search mode" };
  }

  const rawGroup = oneString(raw.group);
  const group =
    rawGroup && GROUPS.includes(rawGroup as SearchGroup)
      ? (rawGroup as SearchGroup)
      : undefined;
  const mode: "preview" | "group" = group
    ? "group"
    : requestedMode === "group"
      ? "group"
      : "preview";
  if ((mode === "group" && !group) || (rawGroup && !group)) {
    return { ok: false as const, message: "A valid search group is required" };
  }

  return {
    ok: true as const,
    value: {
      query,
      mode,
      group,
      page: positiveInteger(raw.page, 1, MAX_PAGE),
      pageSize: positiveInteger(raw.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    } satisfies SearchRequest,
  };
}
