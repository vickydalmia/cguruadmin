import controllers from './controllers';
import routes from './routes';
import services from './services';

export default {
  register({ strapi }) {
    // Register phase: runs before bootstrap
  },
  bootstrap({ strapi }) {
    // Bootstrap phase: plugin is fully loaded
  },
  destroy({ strapi }) {
    // Cleanup phase
  },
  controllers,
  routes,
  services,
};
