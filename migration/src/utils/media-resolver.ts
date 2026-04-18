import { getMediaMapping } from "./id-maps.js";
import { uploadMediaOnDemand } from "../phases/02-media-upload.js";
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
    // Check if already mapped
    const existing = getMediaMapping(numVal);
    if (existing) return existing;

    // Upload on demand
    const fileId = await uploadMediaOnDemand(numVal);
    if (!fileId) {
      logger.debug(`Media ref ${numVal} could not be resolved or uploaded`);
    }
    return fileId;
  }

  // If it's a URL, we can't resolve it to a file ID directly
  logger.debug(`Media ref is a URL, cannot resolve: ${strVal.substring(0, 80)}`);
  return undefined;
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
