import { describe, expect, it, vi } from 'vitest';

import superAdminOnly from './super-admin-only';

function harness(roles: Array<{ code: string }> | null) {
  const findOne = vi.fn().mockResolvedValue(roles === null ? null : { roles });
  return {
    strapi: {
      db: { query: vi.fn(() => ({ findOne })) },
    } as any,
    findOne,
  };
}

describe('super-admin-only policy', () => {
  it('permits only a persisted Super Admin role', async () => {
    const { strapi, findOne } = harness([{ code: 'strapi-super-admin' }]);
    await expect(
      superAdminOnly({ state: { user: { id: 7 } } }, {}, { strapi }),
    ).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledWith({
      where: { id: 7 },
      populate: { roles: { select: ['code'] } },
    });
  });

  it('rejects missing users and non-Super-Admin roles', async () => {
    const { strapi } = harness([{ code: 'strapi-editor' }]);
    await expect(
      superAdminOnly({ state: { user: { id: 9 } } }, {}, { strapi }),
    ).resolves.toBe(false);
    await expect(
      superAdminOnly({ state: {} }, {}, { strapi }),
    ).resolves.toBe(false);
  });
});
