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

export function publishedOnlyFilters() {
  return { contentStatus: { $eq: "published" as const } };
}
