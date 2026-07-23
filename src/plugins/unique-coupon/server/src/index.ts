import controllers from './controllers';
import policies from './policies';
import routes from './routes';
import services from './services';

export default {
  register({ strapi }) {
    // Register phase: runs before bootstrap
  },
  async bootstrap({ strapi }) {
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
  destroy({ strapi }) {
    // Cleanup phase
  },
  controllers,
  policies,
  routes,
  services,
};
