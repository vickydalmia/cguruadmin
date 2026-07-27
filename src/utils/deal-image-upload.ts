import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEAL_IMAGE_PROCESSOR_VERSION,
  DealImageProcessingError,
  prepareTransparentDealImage,
} from './deal-image-background';

type ProcessingMetadata = {
  sourceHash: string;
  version: string;
  processedAt: string;
};

const processingMetadataByPath = new Map<string, ProcessingMetadata>();
const inFlightTransparentUploads = new Map<string, Promise<any>>();

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

const fileIdOf = (value: unknown): number | null => {
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

const transparentFileName = (fileName: string): string => {
  const extension = path.extname(fileName);
  return `${path.basename(fileName, extension) || 'deal-image'}-transparent.png`;
};

function parseFileInfo(body: any, fallbackName: string) {
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

async function uploadPreparedPng(
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

async function sourceBytesForFile(
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

function logUploadFailure(strapi: Core.Strapi, failure: DealImageProcessingError) {
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

export function extendDealImageUploadPlugin(plugin: any): void {
  if (
    !plugin.controllers?.['admin-upload'] ||
    !plugin.controllers?.['admin-file'] ||
    !plugin.routes?.admin?.routes
  ) {
    return;
  }

  const adminUpload = plugin.controllers['admin-upload'];

  adminUpload.uploadDealImage = async (ctx: any) => {
    const permissionManager = strapi
      .service('admin::permission')
      .createPermissionsManager({
        ability: ctx.state.userAbility,
        action: 'plugin::upload.assets.create',
        model: 'plugin::upload.file',
      });
    if (!permissionManager.isAllowed) {
      ctx.forbidden();
      return;
    }

    const incoming = ctx.request.files?.files;
    const file = Array.isArray(incoming) ? incoming[0] : incoming;
    if (!file?.filepath || !file?.size) {
      const failure = new DealImageProcessingError(
        'DEAL_IMAGE_INVALID_SOURCE',
      );
      ctx.status = failure.status;
      ctx.body = { error: failure.toResponse() };
      return;
    }

    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'deal-image-upload-'),
    );
    try {
      strapi.log.info('[deal-image] admin upload processing started', {
        name: file.originalFilename || 'deal-image',
        size: file.size,
      });
      const source = await fs.readFile(file.filepath);
      const prepared = await prepareTransparentDealImage({
        source,
        sourceMime: file.mimetype || 'application/octet-stream',
        fileName: file.originalFilename || 'deal-image',
        outputDirectory: tempDirectory,
        permanent: false,
      });
      const uploaded = await uploadPreparedPng(strapi, prepared, {
        fileName: file.originalFilename || 'deal-image',
        fileInfo: parseFileInfo(
          ctx.request.body,
          file.originalFilename || 'deal-image',
        ),
        user: ctx.state.user,
      });
      strapi.log.info('[deal-image] admin upload processing complete', {
        name: file.originalFilename || 'deal-image',
        transparentFileId: uploaded.id,
        sourceHash: prepared.sourceHash,
        providerSkipped: prepared.skippedProvider,
        providerRequestId: prepared.providerRequestId,
      });
      const signed = await strapi
        .plugin('upload')
        .service('file')
        .signFileUrls(uploaded);
      ctx.body = await permissionManager.sanitizeOutput(signed, {
        action: 'plugin::upload.read',
      });
      ctx.status = 201;
    } catch (error) {
      const failure =
        error instanceof DealImageProcessingError
          ? error
          : new DealImageProcessingError('DEAL_IMAGE_STORAGE_FAILED', {
              cause: error,
            });
      logUploadFailure(strapi, failure);
      ctx.status = failure.status;
      ctx.body = { error: failure.toResponse() };
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  };

  plugin.controllers['admin-file'].findDealImages = async (ctx: any) => {
    const files = await strapi.db.query('plugin::upload.file').findMany({
      where: {
        backgroundRemovalVersion: DEAL_IMAGE_PROCESSOR_VERSION,
      },
      select: [
        'id',
        'documentId',
        'name',
        'alternativeText',
        'caption',
        'width',
        'height',
        'formats',
        'ext',
        'mime',
        'size',
        'url',
        'provider',
        'createdAt',
        'updatedAt',
      ],
      orderBy: { createdAt: 'desc' },
      limit: 100,
    });
    ctx.body = await Promise.all(
      files.map((file: any) =>
        strapi.plugin('upload').service('file').signFileUrls(file),
      ),
    );
  };

  const adminRoutes = plugin.routes.admin.routes;
  adminRoutes.push(
    {
      method: 'POST',
      path: '/deal-image',
      handler: 'admin-upload.uploadDealImage',
      config: {
        policies: [
          'admin::isAuthenticatedAdmin',
          {
            name: 'admin::hasPermissions',
            config: { actions: ['plugin::upload.assets.create'] },
          },
        ],
      },
    },
    {
      method: 'GET',
      path: '/deal-images',
      handler: 'admin-file.findDealImages',
      config: {
        policies: [
          'admin::isAuthenticatedAdmin',
          {
            name: 'admin::hasPermissions',
            config: { actions: ['plugin::upload.read'] },
          },
        ],
      },
    },
  );
}
