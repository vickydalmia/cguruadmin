import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::deal.deal', {
  only: ['find', 'findOne'],
});
