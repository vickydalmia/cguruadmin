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
    falKey: config.fal.key,
    timeoutMs: config.fal.timeoutMs,
    maxAttempts: config.fal.maxAttempts,
  }).finally(() => {
    inFlightPreparations.delete(sourceHash);
  });
  inFlightPreparations.set(sourceHash, task);
  return task;
}
