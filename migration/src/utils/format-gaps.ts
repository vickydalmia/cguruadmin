import {
  BREAKPOINTS,
  expectedAvifTwinKeys,
  IMAGE_OPTIMIZATION,
  THUMBNAIL,
} from "./image-optimizer.js";

// Config-free on purpose: the tsx test suite imports this module directly,
// and config.ts throws on import without .env.migration.

/**
 * provider_metadata key listing AVIF twin keys the size guard dropped (the
 * webp counterpart was already smaller). A dropped twin is a settled outcome,
 * not a gap — recording it keeps the gap selector convergent, where a marker
 * inside formats would break Strapi's delete iteration (formats entries are
 * treated as real files). --overwrite replaces the list with that run's
 * actual drops, so regenerated twins clear stale tombstones.
 */
export const AVIF_DROPPED_META_KEY = "avifDropped";

/** Tombstoned twin keys from a parsed provider_metadata (tolerates any shape). */
export function readAvifTombstones(
  meta: Record<string, any> | null
): Set<string> {
  const raw = meta?.[AVIF_DROPPED_META_KEY];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((key): key is string => typeof key === "string"));
}

/**
 * Union `dropped` into a COPY of meta with a sorted-unique tombstone list.
 * Returns null when nothing new would be recorded, so callers can skip the
 * provider_metadata write entirely.
 */
export function mergeAvifTombstones(
  meta: Record<string, any> | null,
  dropped: readonly string[]
): Record<string, any> | null {
  const existing = readAvifTombstones(meta);
  const next = new Set(existing);
  for (const key of dropped) next.add(key);
  if (next.size === existing.size) return null;
  return { ...(meta ?? {}), [AVIF_DROPPED_META_KEY]: [...next].sort() };
}

/** Missing, retryable AVIF twins after stored entries and drops are removed. */
export function missingAvifTwinKeys(
  formats: Record<string, any> | null,
  tombstoned: ReadonlySet<string>,
  width: number,
  height: number,
): string[] {
  const stored = new Set(Object.keys(formats ?? {}));
  return expectedAvifTwinKeys(width, height).filter(
    (key) => !stored.has(key) && !tombstoned.has(key),
  );
}

/**
 * Phase 14 pass-2 selector: any due AVIF twin that is neither stored nor
 * tombstoned keeps the row eligible. This is intentionally mime-agnostic;
 * phase 14 backfills JPEG/PNG rows as well as WebP rows.
 */
export function buildAvifGapWhere(firstParamIndex: number): {
  sql: string;
  params: number[];
} {
  const params: number[] = [];
  const arms: string[] = [];
  const nextParam = (value: number): string => {
    params.push(value);
    return `$${firstParamIndex + params.length - 1}`;
  };

  arms.push(
    `(NOT (formats::jsonb ? 'original_avif')` +
      ` AND NOT COALESCE((provider_metadata::jsonb -> '${AVIF_DROPPED_META_KEY}') ? 'original_avif', false))`,
  );
  for (const [key, bp] of Object.entries(BREAKPOINTS)) {
    const p = nextParam(bp);
    arms.push(
      `(NOT (formats::jsonb ? '${key}_avif')` +
        ` AND (width > ${p} OR height > ${p})` +
        ` AND NOT COALESCE((provider_metadata::jsonb -> '${AVIF_DROPPED_META_KEY}') ? '${key}_avif', false))`,
    );
  }

  return { sql: arms.join("\n         OR "), params };
}

/**
 * OR-disjunction selecting rows with a gap in the variant matrix, generated
 * from the same constants expectedFormatKeys derives from — SQL and JS can
 * never disagree on what "complete" means. Arms:
 *   - thumbnail / one per breakpoint: key absent AND the master exceeds it
 *   - one per AVIF twin (webp only): key absent AND due AND not tombstoned
 *   - original_avif (webp only): no dims condition — always nominal
 *   - width/height IS NULL: three-valued logic silences every arm above for
 *     dimensionless rows, so they need their own arm
 * COALESCE around each tombstone `?` test is mandatory: provider-created rows
 * have NULL provider_metadata and a bare test would silently deselect them.
 * Thresholds are parameterized starting at $firstParamIndex so the caller can
 * append its own params (e.g. LIMIT) after.
 */
export function buildGapWhere(firstParamIndex: number): {
  sql: string;
  params: number[];
} {
  const params: number[] = [];
  const arms: string[] = [];
  const nextParam = (value: number): string => {
    params.push(value);
    return `$${firstParamIndex + params.length - 1}`;
  };

  const thumbW = nextParam(THUMBNAIL.width);
  const thumbH = nextParam(THUMBNAIL.height);
  arms.push(
    `(NOT (formats::jsonb ? 'thumbnail') AND (width > ${thumbW} OR height > ${thumbH}))`
  );

  for (const [key, bp] of Object.entries(BREAKPOINTS)) {
    const p = nextParam(bp);
    arms.push(
      `(NOT (formats::jsonb ? '${key}') AND (width > ${p} OR height > ${p}))`
    );
  }

  if (IMAGE_OPTIMIZATION.generateAvifTwins) {
    for (const [key, bp] of Object.entries(BREAKPOINTS)) {
      const p = nextParam(bp);
      arms.push(
        `(mime = 'image/webp' AND NOT (formats::jsonb ? '${key}_avif')` +
          ` AND (width > ${p} OR height > ${p})` +
          ` AND NOT COALESCE((provider_metadata::jsonb -> '${AVIF_DROPPED_META_KEY}') ? '${key}_avif', false))`
      );
    }
    arms.push(
      `(mime = 'image/webp' AND NOT (formats::jsonb ? 'original_avif')` +
        ` AND NOT COALESCE((provider_metadata::jsonb -> '${AVIF_DROPPED_META_KEY}') ? 'original_avif', false))`
    );
  }

  arms.push(`(width IS NULL OR height IS NULL)`);

  return { sql: arms.join("\n         OR "), params };
}
