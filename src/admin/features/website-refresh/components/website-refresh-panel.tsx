import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { RefreshControls } from './refresh-controls';
import { useRBAC } from '@strapi/strapi/admin';
const PERMISSIONS = [{ action: 'admin::website-refresh.manage' }];
export const WebsiteRefreshPanel: PanelComponent = ({ model, documentId }) => {
  const { isLoading, allowedActions } = useRBAC(PERMISSIONS);
  if (isLoading || !allowedActions.canManage) return null;
  if (!documentId || !model.startsWith('api::')) return null;
  return { title: 'Website cache', content: <RefreshControls key={`${model}:${documentId}`} uid={model} documentId={documentId} /> };
};
