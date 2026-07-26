interface BackfillRemovalTimestampOptions {
  repairMissingS3: boolean;
  reusedTransparentOutput: boolean;
  previousRemovedAt: string | null;
  processedAt: string;
}

/**
 * Preserve the original removal time only when the current-version bytes
 * already existed locally and are merely being restored to S3. Any actual
 * processing, including a processor-version upgrade, records a fresh time.
 */
export function resolveBackfillRemovalTimestamp({
  repairMissingS3,
  reusedTransparentOutput,
  previousRemovedAt,
  processedAt,
}: BackfillRemovalTimestampOptions): string {
  if (repairMissingS3 && reusedTransparentOutput && previousRemovedAt) {
    return previousRemovedAt;
  }
  return processedAt;
}
