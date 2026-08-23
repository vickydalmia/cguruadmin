import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DealImageProcessingError } from './deal-image-errors';
import { alphaStats, validateTransparentDealPng } from './deal-image-transparency';
import { callFal } from './deal-image-fal';
import {
  atomicWrite,
  readValidPermanentArchive,
  safeFileStem,
  sha256,
} from './deal-image-archive';

// Deal-image PREPARATION ORCHESTRATION. Errors live in ./deal-image-errors,
// transparency validation in ./deal-image-transparency, the FAL provider in
// ./deal-image-fal, and archive handling in ./deal-image-archive.

export interface PreparedTransparentDealImage {
  png: Buffer;
  pngPath: string;
  sourceHash: string;
  width: number;
  height: number;
  providerRequestId?: string;
  reusedArchive: boolean;
  skippedProvider: boolean;
}

export interface PrepareTransparentDealImageOptions {
  source: Buffer;
  sourceMime: string;
  fileName: string;
  outputDirectory: string;
  permanent: boolean;
  /**
   * Migration-only bridge for archives created from a differently encoded
   * copy of the same WordPress attachment. Normal uploads must remain
   * content-hash-only so replacing bytes under the same name cannot reuse a
   * stale transparent image.
   */
  allowLegacyFileNameArchive?: boolean;
  falKey?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  removeBackground?: (
    source: Buffer,
    sourceMime: string,
  ) => Promise<{ png: Buffer; requestId?: string }>;
}

export const DEAL_IMAGE_PROCESSOR_VERSION = 'fal-bria-rmbg-2.0-v1';

export async function prepareTransparentDealImage(
  options: PrepareTransparentDealImageOptions,
): Promise<PreparedTransparentDealImage> {
  const sourceHash = sha256(options.source);
  const suffix = options.permanent
    ? ''
    : `-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const pngPath = path.join(options.outputDirectory, options.permanent
    ? `${sourceHash}.png`
    : `${sourceHash}-${safeFileStem(options.fileName)}${suffix}.png`);

  try {
    await fs.mkdir(options.outputDirectory, { recursive: true });
  } catch (cause) {
    throw new DealImageProcessingError('DEAL_IMAGE_ARCHIVE_WRITE_FAILED', {
      cause,
    });
  }

  if (options.permanent) {
    const archived = await readValidPermanentArchive(
      options.outputDirectory,
      sourceHash,
      options.fileName,
      options.allowLegacyFileNameArchive ?? false,
    );
    if (archived) {
      let archivedPath = archived.pngPath;
      if (!archived.matchedSourceHash) {
        await atomicWrite(pngPath, archived.png);
        archivedPath = pngPath;
      }
      return {
        png: archived.png,
        pngPath: archivedPath,
        sourceHash,
        width: archived.width,
        height: archived.height,
        reusedArchive: true,
        skippedProvider: true,
      };
    }
  }

  const sourceStats = await alphaStats(options.source);
  let png: Buffer;
  let requestId: string | undefined;
  let skippedProvider = false;

  if (sourceStats.meaningful) {
    png = await sharp(options.source, { animated: false })
      .rotate()
      .png()
      .toBuffer();
    skippedProvider = true;
  } else if (options.removeBackground) {
    const result = await options.removeBackground(
      options.source,
      options.sourceMime,
    );
    png = result.png;
    requestId = result.requestId;
  } else {
    const falKey = options.falKey ?? process.env.FAL_KEY;
    if (!falKey) {
      throw new DealImageProcessingError(
        'BACKGROUND_REMOVAL_NOT_CONFIGURED',
      );
    }
    const result = await callFal(options.source, options.sourceMime, {
      falKey,
      timeoutMs: options.timeoutMs ?? 120_000,
      maxAttempts: options.maxAttempts ?? 3,
      fetchImpl: options.fetchImpl ?? fetch,
    });
    png = result.png;
    requestId = result.requestId;
  }

  const dimensions = await validateTransparentDealPng(png);
  await atomicWrite(pngPath, png);
  let persisted: Buffer;
  try {
    persisted = await fs.readFile(pngPath);
  } catch (cause) {
    throw new DealImageProcessingError('DEAL_IMAGE_ARCHIVE_WRITE_FAILED', {
      cause,
      providerRequestId: requestId,
    });
  }
  await validateTransparentDealPng(persisted);

  return {
    png: persisted,
    pngPath,
    sourceHash,
    ...dimensions,
    providerRequestId: requestId,
    reusedArchive: false,
    skippedProvider,
  };
}
