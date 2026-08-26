import {
  CULTURE_GALLERY_MEDIA_FOLDER_NAME,
} from '../../constants/media-folders';
import { extendDealImageUploadPlugin } from '../../utils/deal-image-upload';
import { dealImageProcessingMetadata } from '../../utils/deal-image-upload-metadata';
import { applyUploadSchemaAdditions } from './upload-schema-additions';
import { createImageOptimization } from './upload-master-optimization';
import { createGenerateThumbnail } from './upload-hash-relocation';
import { createResponsiveFormats } from './upload-responsive-formats';
import { withReplacementFolderPreservation } from './upload-folder-preservation';

// Upload extension ENTRYPOINT (Strapi loads exactly this path). Schema
// additions live in ./upload-schema-additions, master optimization in
// ./upload-master-optimization, responsive WebP/AVIF generation in
// ./upload-responsive-formats, hash relocation in ./upload-hash-relocation,
// and replacement-folder preservation in ./upload-folder-preservation.

export default (plugin: any) => {
  const base = plugin.services['image-manipulation'];
  const baseUploadFactory = plugin.services.upload;

  const isCultureGalleryUpload = async (file: any): Promise<boolean> => {
    const folderId = typeof file.folder === 'object' ? file.folder?.id : file.folder;
    if (!folderId) return false;

    const folder = await strapi.db.query('plugin::upload.folder').findOne({
      where: { id: folderId },
      select: ['name'],
    });
    return folder?.name === CULTURE_GALLERY_MEDIA_FOLDER_NAME;
  };

  applyUploadSchemaAdditions(plugin);

  const attachDealImageMetadata = (target: any, sourcePath?: string) => {
    const metadata = dealImageProcessingMetadata(sourcePath);
    if (!metadata) return target;
    target.backgroundRemovalSourceHash = metadata.sourceHash;
    target.backgroundRemovalVersion = metadata.version;
    target.backgroundRemovedAt = metadata.processedAt;
    return target;
  };

  const { isImage, optimize } = createImageOptimization({
    base,
    isCultureGalleryUpload,
    attachDealImageMetadata,
  });
  const generateThumbnail = createGenerateThumbnail({ base });
  const { generateResponsiveFormats, isResizableImage } = createResponsiveFormats({
    base,
  });

  plugin.services['image-manipulation'] = {
    ...base,
    isImage,
    optimize,
    generateThumbnail,
    generateResponsiveFormats,
    isResizableImage,
  };

  // Unlike image-manipulation, Strapi registers the upload service as a
  // factory. Wrap the resolved service rather than looking for methods on the
  // factory itself. The object branch keeps the extension resilient to a
  // future Strapi registration-shape change.
  if (typeof baseUploadFactory === 'function') {
    plugin.services.upload = (context: any) =>
      withReplacementFolderPreservation(baseUploadFactory(context));
  } else {
    plugin.services.upload = withReplacementFolderPreservation(
      baseUploadFactory,
    );
  }
  extendDealImageUploadPlugin(plugin);
  return plugin;
};
