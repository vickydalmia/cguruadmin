import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { useRBAC } from '@strapi/strapi/admin';
import * as React from 'react';

import UniqueCodeImport from '../../components/UniqueCodeImport';

const UNIQUE_CODE_IMPORT_UID = 'api::unique-coupon-pool.unique-coupon-pool';
// Registered by the plugin server (src/plugins/unique-coupon/server/src/
// index.ts) and enforced on its upload/stats routes; granted per role under
// Settings > Roles > Plugins. Module-level so useRBAC sees a stable reference.
const UNIQUE_CODE_IMPORT_PERMISSIONS = [
  { action: 'plugin::unique-coupon.codes.import' },
];

export const UniqueCodeImportPanel: PanelComponent = ({ model, documentId }) => {
  // Called before the model early-return so the hook order never changes.
  const { isLoading, allowedActions } = useRBAC(UNIQUE_CODE_IMPORT_PERMISSIONS);

  if (model !== UNIQUE_CODE_IMPORT_UID) return null;
  if (isLoading || !allowedActions.canImport) return null;

  return {
    title: 'Import codes',
    content: <UniqueCodeImport documentId={documentId} />,
  };
};
