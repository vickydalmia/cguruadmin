export type ContentStatus = "published" | "scheduled" | "expired";

type MigrationLifecycleInput = {
  postStatus?: string | null;
  expiresAt?: string | null;
  now?: Date;
};

/**
 * Decide whether a WordPress offer belongs in Strapi.
 *
 * Only `publish` (including rows whose expiry meta has passed — they import
 * as `expired` entries) and `future` (WP scheduled posts → `scheduled`)
 * import. Drafts and trash NEVER import — this deliberately dropped the old
 * "retain a draft/trash row when an expiry plugin withdrew it" special case:
 * the fresh catalog should not carry withdrawn posts at all.
 */
export function shouldImportMigrationOffer(
  input: MigrationLifecycleInput,
): boolean {
  return input.postStatus === "publish" || input.postStatus === "future";
}

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
