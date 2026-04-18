export type ContentStatus = "published" | "scheduled" | "expired";

export function computeMigrationStatus(input: {
  postDate: string;
  postStatus?: string | null;
  expiresAt?: string | null;
  now?: Date;
}): {
  contentStatus: ContentStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
} {
  const now = input.now ?? new Date();
  const postDate = new Date(input.postDate);
  const postDateIsValid = !Number.isNaN(postDate.getTime());
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  const expiresAtIsValid = expiresAt && !Number.isNaN(expiresAt.getTime());

  if (expiresAtIsValid && expiresAt! <= now) {
    return {
      contentStatus: "expired",
      scheduledAt: null,
      publishedAt: input.postDate,
    };
  }

  const isScheduled =
    input.postStatus === "future" ||
    (postDateIsValid && postDate > now);

  if (isScheduled) {
    return {
      contentStatus: "scheduled",
      scheduledAt: postDateIsValid ? postDate.toISOString() : null,
      publishedAt: null,
    };
  }

  return {
    contentStatus: "published",
    scheduledAt: null,
    publishedAt: input.postDate,
  };
}
