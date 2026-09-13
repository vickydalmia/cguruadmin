import type { Core } from '@strapi/strapi';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TELEGRAM_MAX_PHOTO_BYTES, TELEGRAM_MEDIA_FOLDER_NAME } from '../constants/telegram';
import { DEAL_IMAGE_PROCESSOR_VERSION, prepareTransparentDealImage } from '../utils/deal-image-background';
import { DealImageProcessingError } from '../utils/deal-image-errors';
import { clearDealImageProcessingMetadata, registerDealImageProcessingMetadata } from '../utils/deal-image-upload-metadata';
import type { BotApi, TelegramMessage } from './bot-api';
import type { PrepareTransparentDealImageOptions } from '../utils/deal-image-background';
import type { PhotoStep } from './photo-diagnostics';
import { largestPhoto } from './photo-selection';

export type TelegramPhotoOptions = {
  removeBackground?: PrepareTransparentDealImageOptions['removeBackground'];
  name?: string;
  beforeUpload?: () => Promise<void>;
  onUploaded?: (id: number) => Promise<void>;
  onStep?: (step: PhotoStep) => void;
};

async function telegramMediaFolderId(strapi: Core.Strapi): Promise<number | null> {
  const folder = await strapi.db.query('plugin::upload.folder').findOne({
    where: { name: TELEGRAM_MEDIA_FOLDER_NAME },
    select: ['id'],
  });
  return folder?.id ?? null;
}

function extensionFor(contentType: string | null, filePath: string | undefined): string {
  const fromPath = filePath ? path.extname(filePath).toLowerCase() : '';
  if (fromPath) return fromPath;
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  return '.jpg';
}

export async function rehostPhoto(
  strapi: Core.Strapi,
  api: BotApi,
  message: TelegramMessage,
  title: string | null,
  options: TelegramPhotoOptions = {},
): Promise<{ fileId: number; fileUniqueId: string } | null> {
  const photo = largestPhoto(message);
  if (!photo) {
    if (message.photo?.length) throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE');
    return null;
  }
  options.onStep?.('telegram-file');
  const file = await api.getFile(photo.file_id);
  if (!file.file_path || (file.file_size ?? 0) > TELEGRAM_MAX_PHOTO_BYTES) throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE');
  options.onStep?.('telegram-download');
  const { bytes, contentType } = await api.downloadFile(file.file_path);
  if (bytes.length === 0 || bytes.length > TELEGRAM_MAX_PHOTO_BYTES) throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE');

  const extension = extensionFor(contentType, file.file_path);
  const name = `telegram-${message.chat.id}-${message.message_id}${extension}`;
  const fileId = await uploadTelegramPhoto(strapi, { bytes, contentType, name: options.name ?? name, title }, options);
  return { fileId, fileUniqueId: photo.file_unique_id };
}

/** Same FAL preparation and upload optimization as product images. Each post
 * owns its upload so retention cannot delete another post's or Deal's media. */
export async function uploadTelegramPhoto(
  strapi: Core.Strapi,
  source: { bytes: Buffer; contentType: string | null; name: string; title: string | null },
  options: TelegramPhotoOptions = {},
): Promise<number> {
  options.onStep?.('image-prepare');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-photo-'));
  let preparedPath: string | undefined;
  try {
    const prepared = await prepareTransparentDealImage({
      source: source.bytes,
      sourceMime: source.contentType ?? 'application/octet-stream',
      fileName: source.name,
      outputDirectory: directory,
      permanent: false,
      removeBackground: options.removeBackground && (async (bytes, mime) => {
        const result = await options.removeBackground!(bytes, mime);
        options.onStep?.('image-prepare');
        return result;
      }),
    });
    preparedPath = prepared.pngPath;
    registerDealImageProcessingMetadata(preparedPath, {
      sourceHash: prepared.sourceHash,
      version: DEAL_IMAGE_PROCESSOR_VERSION,
      processedAt: new Date().toISOString(),
    });
    const name = `${path.basename(source.name, path.extname(source.name))}-transparent.png`;
    await options.beforeUpload?.();
    options.onStep?.('image-upload');
    const uploadService: any = strapi.plugin('upload').service('upload');
    const [uploaded] = await uploadService.upload({
      data: {
        fileInfo: {
          name,
          alternativeText: source.title,
          caption: null,
          folder: await telegramMediaFolderId(strapi),
        },
      },
      files: [{ filepath: preparedPath, originalFilename: name, mimetype: 'image/png', detectedMimeType: 'image/png', size: prepared.png.length }],
    });
    if (!uploaded?.id) throw new DealImageProcessingError('DEAL_IMAGE_STORAGE_FAILED');
    await options.onUploaded?.(uploaded.id);
    return uploaded.id;
  } finally {
    if (preparedPath) clearDealImageProcessingMetadata(preparedPath);
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function removeUploadedFile(strapi: Core.Strapi, file: any): Promise<void> {
  if (!file?.id) return;
  try {
    const uploadService: any = strapi.plugin('upload').service('upload');
    const stored = await strapi.db.query('plugin::upload.file').findOne({ where: { id: file.id }, populate: { related: true } as any });
    // Editors can reuse a Telegram upload elsewhere. Only remove orphan media.
    if (stored && !stored.related?.length) await uploadService.remove(stored);
  } catch (err: any) {
    strapi.log.warn(`[telegram] could not delete photo ${file.id}: ${err?.message ?? err}`);
  }
}
