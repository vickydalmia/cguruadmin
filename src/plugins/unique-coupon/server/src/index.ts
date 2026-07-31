import type { Core } from '@strapi/strapi';

import controllers from './controllers';
import policies from './policies';
import routes from './routes';
import services from './services';

export default {
  register({ strapi: _strapi }: { strapi: Core.Strapi }) {
    // Register phase: runs before bootstrap
  },
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    // Admin RBAC action enforced by the upload/stats routes (routes/index.ts)
    // and checked by the admin panel before showing the import side panel.
    // Grantable per role under Settings > Roles > Plugins.
    await strapi.service('admin::permission').actionProvider.registerMany([
      {
        section: 'plugins',
        displayName: 'Import unique codes',
        uid: 'codes.import',
        pluginName: 'unique-coupon',
      },
    ]);
  },
  destroy({ strapi: _strapi }: { strapi: Core.Strapi }) {
    // Cleanup phase
  },
  controllers,
  policies,
  routes,
  services,
};
