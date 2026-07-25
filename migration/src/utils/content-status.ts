export type ContentStatus = "published" | "scheduled" | "expired";

type MigrationLifecycleInput = {
  postStatus?: string | null;
  expiresAt?: string | null;
  now?: Date;
};

/**
 * Decide whether a WordPress offer belongs in Strapi.
 *
 * Normal drafts/trash are intentionally excluded. Some WordPress expiry
 * plugins withdraw an offer by moving it to draft/trash, though, so retain
 * those rows only when their source expiry is valid and has already passed.
 */
export function shouldImportMigrationOffer(
  input: MigrationLifecycleInput,
): boolean {
  if (input.postStatus === "publish" || input.postStatus === "future") {
    return true;
  }
  if (input.postStatus !== "draft" && input.postStatus !== "trash") {
    return false;
  }

  const now = input.now ?? new Date();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  return Boolean(
    expiresAt &&
      !Number.isNaN(expiresAt.getTime()) &&
      expiresAt <= now,
  );
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
