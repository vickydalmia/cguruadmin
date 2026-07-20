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
  now?: Date;
}): ContentStatus {
  const now = input.now ?? new Date();
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
