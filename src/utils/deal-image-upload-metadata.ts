import path from 'node:path';
// Deal-image UPLOAD METADATA: the per-path processing metadata registry
// (single Map, lives here only) and file-id coercion. One of the modules
// split out of deal-image-upload.ts.

export type ProcessingMetadata = {
  sourceHash: string;
  version: string;
  processedAt: string;
};

const processingMetadataByPath = new Map<string, ProcessingMetadata>();

export function registerDealImageProcessingMetadata(
  filePath: string,
  metadata: ProcessingMetadata,
): void {
  processingMetadataByPath.set(path.resolve(filePath), metadata);
}

export function dealImageProcessingMetadata(
  filePath: string | undefined,
): ProcessingMetadata | undefined {
  return filePath
    ? processingMetadataByPath.get(path.resolve(filePath))
    : undefined;
}

export function clearDealImageProcessingMetadata(filePath: string): void {
  processingMetadataByPath.delete(path.resolve(filePath));
}

export const fileIdOf = (value: unknown): number | null => {
  if (value == null) return null;
  if (Array.isArray(value)) return fileIdOf(value[0]);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return fileIdOf(
      object.set ??
        object.connect ??
        object.id ??
        object.apiData,
    );
  }
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
};
