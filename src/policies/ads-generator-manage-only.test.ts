import { expect, it, vi } from 'vitest';
import policy from './ads-generator-manage-only';

it('requires an admin session and an explicit role grant, with Super Admin fallback', async () => {
  let roles: unknown[] = [{ id: 3, code: 'editor' }];
  const findMany = vi.fn(async () => [{ role: { id: 4 } }]);
  const strapi = { db: { query: () => ({ findMany, findOne: async () => ({ roles }) }) } } as any;
  const ctx = { state: { user: { id: 1 }, auth: { strategy: { name: 'admin' } } } };

  expect(await policy(ctx, {}, { strapi })).toBe(false);
  roles = [{ id: 4, code: 'ads-team' }];
  expect(await policy(ctx, {}, { strapi })).toBe(true);
  roles = [{ id: 3, code: 'strapi-super-admin' }];
  expect(await policy(ctx, {}, { strapi })).toBe(true);
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ action: 'admin::ads-generator.generate' }),
  }));
  // A non-admin strategy never reaches the database.
  const read = vi.spyOn(strapi.db, 'query');
  read.mockClear();
  expect(await policy({ state: { user: { id: 1 } } }, {}, { strapi })).toBe(false);
  expect(read).not.toHaveBeenCalled();
});
