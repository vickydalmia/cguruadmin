import {
  uploadFileFromDisk,
  uploadMediaOnDemand,
  type DiskUploadSource,
} from "../phases/02-media-upload.js";
import { getOrLoadMediaItem } from "../phases/01-media-inventory.js";
import {
  resolveUploadsDiskSource,
  resolveUploadsUrl,
} from "./content-media.js";
import {
  DEAL_IMAGE_PROCESSOR_VERSION,
  isContentBackgroundRemovalFailure,
  prepareMigrationDealImage,
} from "./deal-image-background.js";
import { logger } from "./logger.js";

/**
 * Resolves a WordPress attachment reference (ID or URL) to a Strapi file ID.
 * Triggers on-demand upload if the file hasn't been uploaded yet.
 * Returns undefined if the reference can't be resolved.
 */
export async function resolveMediaRef(
  value: string | number | null | undefined
): Promise<number | undefined> {
  if (value === null || value === undefined || value === "") return undefined;

  const strVal = String(value).trim();
  if (!strVal) return undefined;

  // If it's a numeric attachment ID
  const numVal = Number(strVal);
  if (!isNaN(numVal) && numVal > 0) {
    // Resolve against the active files table by source content hash. Saved
    // numeric mappings may belong to a previous dev database whose file IDs
    // were reused for unrelated assets after a reset.
    const fileId = await uploadMediaOnDemand(numVal);
    if (!fileId) {
      logger.debug(`Media ref ${numVal} could not be resolved or uploaded`);
    }
    return fileId;
  }

  // URL reference — resolve via the uploads-path index (on-demand upload)
  const record = await resolveUploadsUrl(strVal);
  if (record) return record.id;

  logger.debug(`Media ref URL could not be resolved: ${strVal.substring(0, 80)}`);
  return undefined;
}

async function dealImageSource(
  value: string | number,
): Promise<DiskUploadSource | undefined> {
  const raw = String(value).trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const item = await getOrLoadMediaItem(numeric);
    if (!item?.localPath) return undefined;
    return {
      localPath: item.localPath,
      fileName: item.fileName,
      mimeType: item.mimeType,
      altText: item.altText,
      caption: item.postTitle,
    };
  }
  return resolveUploadsDiskSource(raw);
}

/**
 * Deal-only resolver. It archives a lossless transparent PNG before the
 * generic optimizer sees the bytes, ensuring an opaque WordPress original is
 * never persisted to S3.
 */
export async function resolveDealMediaRef(
  value: string | number | null | undefined,
): Promise<number | undefined> {
  if (value === null || value === undefined || String(value).trim() === "") {
    return undefined;
  }
  const source = await dealImageSource(value);
  if (!source) {
    logger.debug(`Deal media ref could not be resolved: ${String(value).slice(0, 80)}`);
    return undefined;
  }

  let prepared;
  try {
    prepared = await prepareMigrationDealImage(source);
  } catch (error) {
    // Deliberate exception to the "never persist an opaque original"
    // invariant: when the IMAGE ITSELF defeats background removal, blocking
    // the whole deal helps nobody. Import the original opaque image (no
    // background_removal metadata, so phase 08a / an editorial re-upload can
    // still produce a transparent version later) and say so loudly.
    if (!isContentBackgroundRemovalFailure(error)) throw error;
    logger.warn(
      `[deal-image] background removal cannot process ${source.fileName} ` +
        `(${(error as { code?: string })?.code ?? "unknown"}); importing the ` +
        "ORIGINAL opaque image instead — replace it editorially for a " +
        "transparent card",
    );
    const fallback = await uploadFileFromDisk({
      localPath: source.localPath,
      fileName: source.fileName,
      mimeType: source.mimeType,
      altText: source.altText,
      caption: source.caption,
      throwOnFailure: true,
    });
    return fallback?.id;
  }
  const preparation =
    prepared.reusedArchive
      ? "archive-reused"
      : prepared.skippedProvider
        ? "already-transparent"
        : "fal-background-removed";
  logger.info(
    `[deal-image] ${preparation}: ${source.fileName} ` +
      `(source=${prepared.sourceHash.slice(0, 12)}, ` +
      `${prepared.width}x${prepared.height}, archive=${prepared.pngPath})`,
  );
  const record = await uploadFileFromDisk({
    localPath: prepared.pngPath,
    fileName: `${source.fileName.replace(/\.[^.]+$/, "")}-transparent.png`,
    mimeType: "image/png",
    altText: source.altText,
    caption: source.caption,
    backgroundRemoval: {
      sourceHash: prepared.sourceHash,
      version: DEAL_IMAGE_PROCESSOR_VERSION,
      removedAt: new Date().toISOString(),
    },
    throwOnFailure: true,
  });
  if (record) {
    logger.info(
      `[deal-image] optimized transparent media ready: ${source.fileName} ` +
        `(file_id=${record.id}, url=${record.url})`,
    );
  }
  return record?.id;
}

/**
 * Inserts a files_related_morphs row linking a file to an entity.
 */
export function buildFilesMorphInsert(
  fileId: number,
  relatedType: string,
  relatedId: number,
  field: string,
  order: number = 1
): {
  file_id: number;
  related_id: number;
  related_type: string;
  field: string;
  order: number;
} {
  return {
    file_id: fileId,
    related_id: relatedId,
    related_type: relatedType,
    field,
    order,
  };
}
