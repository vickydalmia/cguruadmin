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

function adminSession(user: unknown) {
  return { state: { user, auth: { strategy: { name: 'admin' } } } };
}

describe('super-admin-only policy', () => {
  it('permits only a persisted Super Admin role', async () => {
    const { strapi, findOne } = harness([{ code: 'strapi-super-admin' }]);
    await expect(
      superAdminOnly(adminSession({ id: 7 }), {}, { strapi }),
    ).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledWith({
      where: { id: 7 },
      populate: { roles: { select: ['code'] } },
    });
  });

  it('rejects missing users and non-Super-Admin roles', async () => {
    const { strapi } = harness([{ code: 'strapi-editor' }]);
    await expect(
      superAdminOnly(adminSession({ id: 9 }), {}, { strapi }),
    ).resolves.toBe(false);
    await expect(
      superAdminOnly(adminSession(undefined), {}, { strapi }),
    ).resolves.toBe(false);
  });

  // Regression: the guard used to run on a content-API route, where
  // `state.user` is a plugin::users-permissions.user. Looking that id up in
  // admin::user compares unrelated id spaces, so a site user whose numeric id
  // collided with a Super Admin's would have been let through.
  it('rejects every non-admin-session strategy even when the id collides', async () => {
    const { strapi, findOne } = harness([{ code: 'strapi-super-admin' }]);
    const collidingId = { id: 1 };

    for (const strategy of ['users-permissions', 'api-token', 'admin-token']) {
      await expect(
        superAdminOnly(
          { state: { user: collidingId, auth: { strategy: { name: strategy } } } },
          {},
          { strapi },
        ),
      ).resolves.toBe(false);
    }

    // No strategy at all (policy mounted somewhere it should not be).
    await expect(
      superAdminOnly({ state: { user: collidingId } }, {}, { strapi }),
    ).resolves.toBe(false);

    // Fails closed before touching the database.
    expect(findOne).not.toHaveBeenCalled();
  });
});
