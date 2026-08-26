// Deal-image PREPARED-FILE PERSISTENCE: naming, upload-body parsing, the
// deduplicated prepared-PNG upload (in-flight Map lives here only), and
// source-byte reads. One of the modules split out of deal-image-upload.ts.
import type { Core } from '@strapi/strapi';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEAL_IMAGE_PROCESSOR_VERSION,
  prepareTransparentDealImage,
} from './deal-image-background';
import { DealImageProcessingError } from './deal-image-errors';
import {
  clearDealImageProcessingMetadata,
  registerDealImageProcessingMetadata,
  type ProcessingMetadata,
} from './deal-image-upload-metadata';

const inFlightTransparentUploads = new Map<string, Promise<any>>();

const transparentFileName = (fileName: string): string => {
  const extension = path.extname(fileName);
  return `${path.basename(fileName, extension) || 'deal-image'}-transparent.png`;
};

export function parseFileInfo(body: any, fallbackName: string) {
  const raw = body?.fileInfo;
  if (!raw) {
    return {
      name: transparentFileName(fallbackName),
      alternativeText: null,
      caption: null,
      folder: null,
    };
  }
  try {
    const parsed =
      typeof raw === 'string'
        ? JSON.parse(raw)
        : Array.isArray(raw)
          ? typeof raw[0] === 'string'
            ? JSON.parse(raw[0])
            : raw[0]
          : raw;
    return {
      name: transparentFileName(parsed?.name || fallbackName),
      alternativeText: parsed?.alternativeText ?? null,
      caption: parsed?.caption ?? null,
      folder: parsed?.folder ?? null,
    };
  } catch {
    return {
      name: transparentFileName(fallbackName),
      alternativeText: null,
      caption: null,
      folder: null,
    };
  }
}

export async function uploadPreparedPng(
  strapi: Core.Strapi,
  prepared: Awaited<ReturnType<typeof prepareTransparentDealImage>>,
  options: {
    fileName: string;
    fileInfo?: Record<string, unknown>;
    user?: { id: number };
  },
): Promise<any> {
  const uploadKey = `${prepared.sourceHash}:${DEAL_IMAGE_PROCESSOR_VERSION}`;
  const pending = inFlightTransparentUploads.get(uploadKey);
  if (pending) return pending;

  const task = doUploadPreparedPng(strapi, prepared, options).finally(() => {
    inFlightTransparentUploads.delete(uploadKey);
  });
  inFlightTransparentUploads.set(uploadKey, task);
  return task;
}

async function doUploadPreparedPng(
  strapi: Core.Strapi,
  prepared: Awaited<ReturnType<typeof prepareTransparentDealImage>>,
  options: {
    fileName: string;
    fileInfo?: Record<string, unknown>;
    user?: { id: number };
  },
): Promise<any> {
  const existing = await strapi.db.query('plugin::upload.file').findOne({
    where: {
      backgroundRemovalSourceHash: prepared.sourceHash,
      backgroundRemovalVersion: DEAL_IMAGE_PROCESSOR_VERSION,
    },
  });
  if (existing) return existing;

  const metadata: ProcessingMetadata = {
    sourceHash: prepared.sourceHash,
    version: DEAL_IMAGE_PROCESSOR_VERSION,
    processedAt: new Date().toISOString(),
  };
  registerDealImageProcessingMetadata(prepared.pngPath, metadata);
  try {
    const file = {
      filepath: prepared.pngPath,
      originalFilename: transparentFileName(options.fileName),
      mimetype: 'image/png',
      detectedMimeType: 'image/png',
      size: prepared.png.length,
    };
    const uploadService = strapi.plugin('upload').service('upload');
    const [uploaded] = await uploadService.upload(
      {
        data: {
          fileInfo: {
            name: transparentFileName(options.fileName),
            alternativeText: null,
            caption: null,
            folder: null,
            ...options.fileInfo,
          },
        },
        files: [file],
      },
      { user: options.user },
    );
    return uploaded;
  } catch (cause) {
    throw cause instanceof DealImageProcessingError
      ? cause
      : new DealImageProcessingError('DEAL_IMAGE_STORAGE_FAILED', { cause });
  } finally {
    clearDealImageProcessingMetadata(prepared.pngPath);
  }
}

export async function sourceBytesForFile(
  strapi: Core.Strapi,
  file: any,
): Promise<Buffer> {
  const url = typeof file?.url === 'string' ? file.url : '';
  if (!url) {
    throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE');
  }
  if (url.startsWith('/')) {
    const appRoot = (strapi as any).dirs.app.root;
    try {
      return await fs.readFile(path.join(appRoot, 'public', url));
    } catch (cause) {
      throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE', {
        cause,
      });
    }
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`source download returned ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE', { cause });
  }
}
