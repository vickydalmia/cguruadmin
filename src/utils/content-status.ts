export type ContentStatus = "published" | "scheduled" | "expired";

type DateLike = Date | string | null | undefined;

function toDate(value: DateLike): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function computeContentStatus(input: {
  scheduledAt?: DateLike;
  expiresAt?: DateLike;
  /**
   * True when this offer draws its code from a unique pool that has run out.
   * Such an offer is over regardless of its dates — every visitor who reaches
   * it gets nothing.
   *
   * This belongs HERE rather than being written straight onto the offer,
   * because offer-lifecycle-validation recomputes contentStatus from the dates
   * on every human save. A status stamped anywhere else would silently revert
   * the next time an editor touched the record.
   */
  poolExhausted?: boolean;
  now?: Date;
}): ContentStatus {
  const now = input.now ?? new Date();
  if (input.poolExhausted) {
    return "expired";
  }

  const expiresAt = toDate(input.expiresAt);
  if (expiresAt && expiresAt <= now) {
    return "expired";
  }

  const scheduledAt = toDate(input.scheduledAt);
  if (scheduledAt && scheduledAt > now) {
    return "scheduled";
  }

  return "published";
}

// Public visibility filter for coupons/deals. Besides contentStatus, it
// excludes offers whose expiresAt has already passed — the 5-minute cron
// flips contentStatus eventually, but queries must not serve dead offers in
// the window before it runs. The expiry clause is wrapped in $and because
// several call sites spread this object into filters that already carry a
// top-level $or (e.g. store service), which a bare $or key would clobber.
export function publishedOnlyFilters(cutoff: Date | string = new Date()) {
  const cutoffIso = cutoff instanceof Date ? cutoff.toISOString() : cutoff;
  return {
    contentStatus: { $eq: "published" as const },
    $and: [
      {
        $or: [
          { expiresAt: { $null: true } },
          { expiresAt: { $gt: cutoffIso } },
        ],
      },
    ],
  };
}
