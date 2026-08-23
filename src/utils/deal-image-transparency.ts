// Deal-image PNG TRANSPARENCY VALIDATION. One of the modules split out of
// deal-image-background.ts.
import sharp, { type Metadata } from 'sharp';
import { DealImageProcessingError } from './deal-image-errors';

export async function alphaStats(
  input: Buffer,
): Promise<{ meaningful: boolean; width: number; height: number }> {
  let metadata: Metadata;
  try {
    metadata = await sharp(input, { animated: false }).metadata();
  } catch (cause) {
    throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE', { cause });
  }

  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
    throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE');
  }

  const { data, info } = await sharp(input, { animated: false })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  let transparent = 0;
  for (let offset = 3; offset < data.length; offset += info.channels) {
    if (data[offset] < 250) transparent += 1;
  }
  const minimum = Math.max(16, Math.ceil(total * 0.001));
  return {
    meaningful: Boolean(metadata.hasAlpha && transparent >= minimum),
    width: info.width,
    height: info.height,
  };
}

export async function validateTransparentDealPng(
  input: Buffer,
): Promise<{ width: number; height: number }> {
  let metadata: Metadata;
  try {
    metadata = await sharp(input, { animated: false }).metadata();
  } catch (cause) {
    throw new DealImageProcessingError(
      'BACKGROUND_REMOVAL_INVALID_OUTPUT',
      { cause },
    );
  }
  if (metadata.format !== 'png') {
    throw new DealImageProcessingError('BACKGROUND_REMOVAL_INVALID_OUTPUT');
  }
  const stats = await alphaStats(input).catch((cause) => {
    if (
      cause instanceof DealImageProcessingError &&
      cause.code === 'DEAL_IMAGE_INVALID_SOURCE'
    ) {
      throw new DealImageProcessingError(
        'BACKGROUND_REMOVAL_INVALID_OUTPUT',
        { cause },
      );
    }
    throw cause;
  });
  if (!stats.meaningful) {
    throw new DealImageProcessingError('BACKGROUND_REMOVAL_INVALID_OUTPUT');
  }
  return { width: stats.width, height: stats.height };
}
