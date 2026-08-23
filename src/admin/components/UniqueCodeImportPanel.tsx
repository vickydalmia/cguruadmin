import { useRBAC } from '@strapi/strapi/admin';
import type { PanelComponent } from '@strapi/content-manager/strapi-admin';

import UniqueCodeImport from './UniqueCodeImport';

// Bulk code import. The server-side importer already existed and was fully
// implemented — this panel is the only thing that was missing, so editors had
// no way to load a pool without hitting the API by hand.
const UNIQUE_CODE_IMPORT_UID = 'api::unique-coupon-pool.unique-coupon-pool';

// Registered by the plugin server (src/plugins/unique-coupon/server/src/
// index.ts) and enforced on its upload/stats routes; granted per role under
// Settings > Roles > Plugins. Module-level so useRBAC sees a stable reference.
const UNIQUE_CODE_IMPORT_PERMISSIONS = [
  { action: 'plugin::unique-coupon.codes.import' },
];

const UniqueCodeImportPanel: PanelComponent = ({ model, documentId }) => {
  // Called before the model early-return so the hook order never changes.
  const { isLoading, allowedActions } = useRBAC(UNIQUE_CODE_IMPORT_PERMISSIONS);

  if (model !== UNIQUE_CODE_IMPORT_UID) return null;

  // While permissions load, show nothing rather than flashing a panel that may
  // disappear; the server enforces the same action, this only hides the UI.
  if (isLoading || !allowedActions.canImport) return null;

  return {
    title: 'Import codes',
    content: <UniqueCodeImport documentId={documentId} />,
  };
};

export default UniqueCodeImportPanel;
