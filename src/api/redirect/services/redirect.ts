import { factories } from '@strapi/strapi';

// See controllers/redirect.ts — the cast goes away once the generated content
// type union includes 'api::redirect.redirect'.
export default factories.createCoreService('api::redirect.redirect' as never);
