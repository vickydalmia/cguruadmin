import { describe, expect, it, vi } from 'vitest';

import uiDictionaryManageOnly from './ui-dictionary-manage-only';
import translationManageOnly from './translation-manage-only';

type Grant = { role: { id: number } };

function harness(input: {
  grants: Grant[];
  user: { roles: Array<{ id: number; code: string }> } | null;
}) {
  const findMany = vi.fn().mockResolvedValue(input.grants);
  const findOne = vi.fn().mockResolvedValue(input.user);
  const query = vi.fn((uid: string) =>
    uid === 'admin::permission' ? { findMany } : { findOne },
  );
  return { strapi: { db: { query } } as any, findMany, findOne, query };
}

function adminSession(user: unknown) {
  return { state: { user, auth: { strategy: { name: 'admin' } } } };
}

describe('ui-dictionary-manage-only policy', () => {
  it('looks up grants of the ui-dictionary.manage action', async () => {
    const { strapi, findMany } = harness({
      grants: [{ role: { id: 3 } }],
      user: { roles: [{ id: 3, code: 'strapi-editor' }] },
    });
    await expect(
      uiDictionaryManageOnly(adminSession({ id: 7 }), {}, { strapi }),
    ).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: { action: 'admin::ui-dictionary.manage' },
      populate: { role: { select: ['id'] } },
    });
  });

  it('rejects a role without the grant and permits a Super Admin regardless', async () => {
    const denied = harness({
      grants: [{ role: { id: 3 } }],
      user: { roles: [{ id: 4, code: 'strapi-author' }] },
    });
    await expect(
      uiDictionaryManageOnly(adminSession({ id: 7 }), {}, { strapi: denied.strapi }),
    ).resolves.toBe(false);

    const superAdmin = harness({
      grants: [{ role: { id: 3 } }],
      user: { roles: [{ id: 1, code: 'strapi-super-admin' }] },
    });
    await expect(
      uiDictionaryManageOnly(adminSession({ id: 7 }), {}, { strapi: superAdmin.strapi }),
    ).resolves.toBe(true);
  });

  it('falls back to Super Admin only while no role holds the action', async () => {
    const editor = harness({
      grants: [],
      user: { roles: [{ id: 3, code: 'strapi-editor' }] },
    });
    await expect(
      uiDictionaryManageOnly(adminSession({ id: 7 }), {}, { strapi: editor.strapi }),
    ).resolves.toBe(false);
    expect(editor.findOne).toHaveBeenCalledWith({
      where: { id: 7 },
      populate: { roles: { select: ['code'] } },
    });

    const owner = harness({
      grants: [],
      user: { roles: [{ id: 1, code: 'strapi-super-admin' }] },
    });
    await expect(
      uiDictionaryManageOnly(adminSession({ id: 7 }), {}, { strapi: owner.strapi }),
    ).resolves.toBe(true);
  });

  it('fails closed for every non-admin-session strategy before touching the database', async () => {
    const { strapi, findMany, findOne } = harness({
      grants: [{ role: { id: 1 } }],
      user: { roles: [{ id: 1, code: 'strapi-super-admin' }] },
    });
    for (const strategy of ['users-permissions', 'api-token', 'admin-token']) {
      await expect(
        uiDictionaryManageOnly(
          { state: { user: { id: 1 }, auth: { strategy: { name: strategy } } } },
          {},
          { strapi },
        ),
      ).resolves.toBe(false);
    }
    await expect(
      uiDictionaryManageOnly({ state: { user: { id: 1 } } }, {}, { strapi }),
    ).resolves.toBe(false);
    await expect(
      uiDictionaryManageOnly(adminSession(undefined), {}, { strapi }),
    ).resolves.toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('translation-manage-only policy (shared lookup)', () => {
  it('still decides on the translation.manage action', async () => {
    const { strapi, findMany } = harness({
      grants: [{ role: { id: 3 } }],
      user: { roles: [{ id: 3, code: 'strapi-editor' }] },
    });
    await expect(
      translationManageOnly(adminSession({ id: 7 }), {}, { strapi }),
    ).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: { action: 'admin::translation.manage' },
      populate: { role: { select: ['id'] } },
    });
  });
});
