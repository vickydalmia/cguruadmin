export type ContentStatus = "published" | "scheduled" | "expired";

type MigrationLifecycleInput = {
  postStatus?: string | null;
  expiresAt?: string | null;
  now?: Date;
};

/**
 * Decide whether a WordPress offer belongs in Strapi.
 *
 * Only non-expired `publish` and `future` posts import. Drafts, trash, and
 * rows with a valid expiry at or before the migration time NEVER import.
 * Invalid/missing expiry metadata is treated as no expiry so a malformed
 * optional field cannot silently delete an otherwise valid offer.
 */
export function shouldImportMigrationOffer(
  input: MigrationLifecycleInput,
): boolean {
  if (input.postStatus !== "publish" && input.postStatus !== "future") {
    return false;
  }

  if (!input.expiresAt) return true;
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return true;
  return expiresAt > (input.now ?? new Date());
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
