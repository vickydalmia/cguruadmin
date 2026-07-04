import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::store.store', {
  only: ['find', 'findOne'],
});
