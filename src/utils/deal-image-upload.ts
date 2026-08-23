import type { Core } from '@strapi/strapi';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DealImageProcessingError } from './deal-image-errors';
import {
  DEAL_IMAGE_PROCESSOR_VERSION,
  prepareTransparentDealImage,
} from './deal-image-background';
import { dealImageProcessingMetadata } from './deal-image-upload-metadata';
import {
  parseFileInfo,
  uploadPreparedPng,
} from './deal-image-upload-persistence';
import { logUploadFailure } from './deal-image-write-validation';

// Deal-image PLUGIN EXTENSION WIRING. Metadata registry:
// ./deal-image-upload-metadata; prepared-file persistence:
// ./deal-image-upload-persistence; write validation:
// ./deal-image-write-validation.

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
