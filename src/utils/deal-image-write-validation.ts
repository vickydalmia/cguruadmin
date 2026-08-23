// Deal-image WRITE VALIDATION: the write-time candidate check and the
// ensure-transparent step the validation pipeline runs. One of the modules
// split out of deal-image-upload.ts.
import type { Core } from '@strapi/strapi';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errors } from '@strapi/utils';
import {
  DEAL_IMAGE_PROCESSOR_VERSION,
  prepareTransparentDealImage,
} from './deal-image-background';
import { DealImageProcessingError } from './deal-image-errors';
import {
  dealImageProcessingMetadata,
  fileIdOf,
} from './deal-image-upload-metadata';
import {
  sourceBytesForFile,
  uploadPreparedPng,
} from './deal-image-upload-persistence';

async function dealImageProcessingCandidate(
  strapi: Core.Strapi,
  data: any,
): Promise<any | null> {
  if (
    !data ||
    typeof data !== 'object' ||
    !Object.prototype.hasOwnProperty.call(data, 'dealImage')
  ) {
    return null;
  }
  const fileId = fileIdOf(data.dealImage);
  if (!fileId) return null;

  const file = await strapi.db.query('plugin::upload.file').findOne({
    where: { id: fileId },
    select: [
      'id',
      'name',
      'url',
      'mime',
      'alternativeText',
      'caption',
      'backgroundRemovalVersion',
    ],
  });
  return file && file.backgroundRemovalVersion !== DEAL_IMAGE_PROCESSOR_VERSION
    ? file
    : null;
}

export async function ensureTransparentDealImageForWrite(
  strapi: Core.Strapi,
  data: any,
): Promise<void> {
  const file = await dealImageProcessingCandidate(strapi, data);
  if (!file) return;

  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'deal-image-write-'),
  );
  try {
    strapi.log.info('[deal-image] document write processing started', {
      sourceFileId: file.id,
      sourceName: file.name,
    });
    const source = await sourceBytesForFile(strapi, file);
    const prepared = await prepareTransparentDealImage({
      source,
      sourceMime: file.mime || 'application/octet-stream',
      fileName: file.name || 'deal-image',
      outputDirectory: tempDirectory,
      permanent: false,
    });
    const user = (strapi as any).requestContext.get()?.state?.user;
    const uploaded = await uploadPreparedPng(strapi, prepared, {
      fileName: file.name || 'deal-image',
      fileInfo: {
        alternativeText: file.alternativeText ?? null,
        caption: file.caption ?? null,
      },
      user,
    });
    data.dealImage = uploaded.id;
    strapi.log.info('[deal-image] document write processing complete', {
      sourceFileId: file.id,
      transparentFileId: uploaded.id,
      sourceHash: prepared.sourceHash,
      archiveReused: prepared.reusedArchive,
      providerSkipped: prepared.skippedProvider,
      providerRequestId: prepared.providerRequestId,
    });
  } catch (error) {
    const failure =
      error instanceof DealImageProcessingError
        ? error
        : new DealImageProcessingError('BACKGROUND_REMOVAL_UNAVAILABLE', {
            cause: error,
          });
    strapi.log.error('[deal-image] document write background removal failed', {
      code: failure.code,
      referenceId: failure.referenceId,
      providerRequestId: failure.providerRequestId,
      cause:
        failure.cause instanceof Error
          ? failure.cause.message
          : String(failure.cause ?? ''),
    });
    throw new errors.ValidationError(failure.message, {
      errors: [
        {
          path: ['dealImage'],
          message: failure.message,
          name: 'ValidationError',
        },
      ],
      code: failure.code,
      referenceId: failure.referenceId,
    });
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

export function logUploadFailure(strapi: Core.Strapi, failure: DealImageProcessingError) {
  strapi.log.error('[deal-image] upload failed', {
    code: failure.code,
    referenceId: failure.referenceId,
    providerRequestId: failure.providerRequestId,
    cause:
      failure.cause instanceof Error
        ? failure.cause.message
        : String(failure.cause ?? ''),
  });
}
