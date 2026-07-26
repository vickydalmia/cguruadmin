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
