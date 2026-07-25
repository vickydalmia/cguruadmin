import { useFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';
import {
  dealImageAssetSchema,
  dealImageAssetsSchema,
  type DealImageAsset,
} from './deal-image-contract';

export {
  dealImageError,
  type DealImageApiError,
  type DealImageAsset,
} from './deal-image-contract';

export function useDealImageApi() {
  const { get, post } = useFetchClient();

  const upload = React.useCallback(
    async (file: File): Promise<DealImageAsset> => {
      const form = new FormData();
      form.append('files', file);
      form.append(
        'fileInfo',
        JSON.stringify({
          name: file.name,
          alternativeText: null,
          caption: null,
          folder: null,
        }),
      );
      const response = await post('/upload/deal-image', form);
      return dealImageAssetSchema.parse(response.data);
    },
    [post],
  );

  const list = React.useCallback(
    async (): Promise<DealImageAsset[]> => {
      const response = await get('/upload/deal-images');
      return dealImageAssetsSchema.parse(response.data);
    },
    [get],
  );

  return React.useMemo(() => ({ upload, list }), [list, upload]);
}
