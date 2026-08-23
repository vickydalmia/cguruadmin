import type { PanelComponent } from '@strapi/content-manager/strapi-admin';

import { RELATION_CONFIG } from '../config';
import { PanelBody } from './panel-body';

export const RelationMultiSelectPanel: PanelComponent = ({ model, documentId }) => {
  if (!RELATION_CONFIG[model]) return null;

  return {
    title: 'Taxonomies',
    content: <PanelBody model={model} documentId={documentId} />,
  };
};
