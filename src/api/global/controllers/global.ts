import { factories } from '@strapi/strapi';
import { loadNewsletterConfig } from '../services/integrations';

export default factories.createCoreController('api::global.global', ({ strapi }) => ({
  async newsletterConfig(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.send({ data: await loadNewsletterConfig(strapi) });
  },
}));
