// Upload REPLACEMENT-FOLDER PRESERVATION: replace() without an explicit
// folder keeps the existing asset's folder, so Culture Gallery replacements
// get the photo profile. One of the modules split out of strapi-server.ts.

// Strapi's normal Media Library replace request does not include fileInfo.folder.
// enhanceAndValidateFile therefore optimizes the incoming bytes before it knows
// which folder the existing asset belongs to. Preserve that folder in the
// replacement payload so Culture Gallery replacements receive the same photo
// profile as fresh uploads. Explicit caller choices (including null/root) win.
export const withReplacementFolderPreservation = (baseUpload: any) => {
  if (!baseUpload?.replace || !baseUpload?.findOne) return baseUpload;

  return {
    ...baseUpload,
    async replace(id: string | number, payload: any, options?: any) {
      const fileInfo = payload?.data?.fileInfo;
      if (fileInfo?.folder !== undefined) {
        return baseUpload.replace(id, payload, options);
      }

      const existing = await baseUpload.findOne(id, { folder: true });
      const folderId = typeof existing?.folder === 'object'
        ? existing.folder?.id
        : existing?.folder;
      if (folderId == null) {
        return baseUpload.replace(id, payload, options);
      }

      return baseUpload.replace(
        id,
        {
          ...payload,
          data: {
            ...(payload?.data ?? {}),
            fileInfo: {
              ...(fileInfo ?? {}),
              folder: folderId,
            },
          },
        },
        options,
      );
    },
  };
};
