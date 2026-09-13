import { expect, it, vi } from 'vitest';
import { listStoredTelegramPosts } from './admin-processing';
import { registerTelegramProcessingRoutes } from '../register/admin-routes';

it('exposes a paginated read-only projection with optimized thumbnails', async () => {
  const findMany = vi.fn(async () => [{ documentId: 'post', messageId: 1, title: '50% off', postedAt: '2026-09-13', hidden: false,
    permalink: 'https://t.me/fixture/1', entities: ['private'], photoFileUniqueId: 'private',
    photo: { url: '/original.png', formats: { thumbnail: { url: '/thumbnail.webp' } } } }]);
  const strapi = { db: { query: () => ({ findMany, count: async () => 40 }) } } as any;
  const result = await listStoredTelegramPosts(strapi, 2);
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ offset: 20, limit: 20 }));
  expect(result.total).toBe(40);
  expect(result.jobs[0]).toMatchObject({ stage: 'ready', title: '50% off', photo: { url: '/thumbnail.webp' } });
  expect(result.jobs[0]).not.toHaveProperty('entities');
  expect(result.jobs[0]).not.toHaveProperty('photoFileUniqueId');
});

it('requires an authenticated Super Admin for every processing and stored-post endpoint', () => {
  const routes = vi.fn();
  registerTelegramProcessingRoutes({ server: { routes } } as any);
  const registration = routes.mock.calls[0][0];
  expect(registration.type).toBe('admin');
  for (const route of registration.routes) expect(route.config.policies).toEqual(['admin::isAuthenticatedAdmin', 'global::super-admin-only']);
  expect(registration.routes.find(route => route.path === '/posts')).toMatchObject({ method: 'GET' });
});
