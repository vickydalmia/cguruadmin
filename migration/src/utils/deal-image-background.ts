import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const backgroundModule = await import(
  "../../../src/utils/deal-image-background.js"
);

export const DEAL_IMAGE_PROCESSOR_VERSION =
  backgroundModule.DEAL_IMAGE_PROCESSOR_VERSION;

export const DEAL_IMAGE_ARCHIVE_DIR = path.resolve(
  __dirname,
  "../../background-removed-deal-images",
  DEAL_IMAGE_PROCESSOR_VERSION,
);

export interface MigrationDealImageSource {
  localPath: string;
  fileName: string;
  mimeType: string;
  altText?: string | null;
  caption?: string | null;
}

/**
 * Failures determined by the IMAGE CONTENT itself — retrying or fixing config
 * cannot help (FAL returned no meaningful mask, rejected the format, or the
 * source is undecodable). These soft-fall-back to importing the original
 * opaque image. Config/credit/transient failures (NOT_CONFIGURED,
 * CREDITS_EXHAUSTED, RATE_LIMITED, TIMED_OUT, UNAVAILABLE) still fail hard —
 * soft-falling those would silently import the whole catalog opaque.
 */
const CONTENT_FAILURE_CODES = new Set([
  "BACKGROUND_REMOVAL_INVALID_OUTPUT",
  "BACKGROUND_REMOVAL_REJECTED",
  "DEAL_IMAGE_INVALID_SOURCE",
]);

export function isContentBackgroundRemovalFailure(error: unknown): boolean {
  return CONTENT_FAILURE_CODES.has((error as { code?: string })?.code ?? "");
}

const inFlightPreparations = new Map<string, Promise<any>>();

export async function prepareMigrationDealImage(
  source: MigrationDealImageSource,
) {
  const sourceBytes = fs.readFileSync(source.localPath);
  const sourceHash = crypto
    .createHash("sha256")
    .update(sourceBytes)
    .digest("hex");
  const pending = inFlightPreparations.get(sourceHash);
  if (pending) return pending;

  const task = backgroundModule.prepareTransparentDealImage({
    source: sourceBytes,
    sourceMime: source.mimeType,
    fileName: source.fileName,
    outputDirectory: DEAL_IMAGE_ARCHIVE_DIR,
    permanent: true,
    // Phase 08a historically archived the optimized Strapi representation,
    // while Phase 08 reads the original WordPress bytes. The picture and
    // original filename are stable, but the byte hashes differ. This
    // migration-only bridge reuses one unambiguous legacy filename match and
    // aliases it under the current source hash instead of paying FAL twice.
    allowLegacyFileNameArchive: true,
    falKey: config.fal.key,
    timeoutMs: config.fal.timeoutMs,
    maxAttempts: config.fal.maxAttempts,
  }).finally(() => {
    inFlightPreparations.delete(sourceHash);
  });
  inFlightPreparations.set(sourceHash, task);
  return task;
}
