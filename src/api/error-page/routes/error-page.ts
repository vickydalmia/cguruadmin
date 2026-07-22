import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::error-page.error-page' as any, {
  only: ['find'],
});
