import { expect, it, vi } from 'vitest';
import policy from './website-refresh-manage-only';

it('requires an admin session and an explicit role grant, with Super Admin fallback', async () => {
  let roles: unknown[] = [{ id: 3, code: 'editor' }];
  const strapi = { db: { query: () => ({ findMany: async () => [{ role: { id: 4 } }], findOne: async () => ({ roles }) }) } } as any;
  const ctx = { state: { user: { id: 1 }, auth: { strategy: { name: 'admin' } } } };
  expect(await policy(ctx, {}, { strapi })).toBe(false);
  roles = [{ id: 4, code: 'refresh-manager' }];
  expect(await policy(ctx, {}, { strapi })).toBe(true);
  roles = [{ id: 3, code: 'strapi-super-admin' }];
  expect(await policy(ctx, {}, { strapi })).toBe(true);
  const read = vi.spyOn(strapi.db, 'query');
  read.mockClear();
  expect(await policy({ state: { user: { id: 1 } } }, {}, { strapi })).toBe(false);
  expect(read).not.toHaveBeenCalled();
});
