import type { Core } from '@strapi/strapi';
import { TRANSLATION_ACTION } from '../api/translation/controllers/translation';

const ADMIN_SESSION_STRATEGY = 'admin';

/**
 * Gate for endpoints that trigger PAID LLM work per entry. Same
 * strategy-assertion rules as global::super-admin-only (only sound on an
 * admin-type route); the decision itself is the assignable
 * `translation.manage` RBAC action, so the owner can grant editors the
 * Translate button per role in Settings → Roles. Super Admins pass by
 * construction — their role carries every registered action.
 */
export default async (
  policyContext: any,
  _config: unknown,
  { strapi }: { strapi: Core.Strapi },
): Promise<boolean> => {
  if (policyContext?.state?.auth?.strategy?.name !== ADMIN_SESSION_STRATEGY) {
    return false;
  }
  const userId = Number(policyContext?.state?.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;

  const permissions: any[] = await strapi.db
    .query('admin::permission')
    .findMany({
      where: { action: TRANSLATION_ACTION },
      populate: { role: { select: ['id'] } },
    });
  if (!permissions.length) return isSuperAdmin(strapi, userId);
  const allowedRoleIds = new Set(
    permissions
      .map((permission) => Number(permission?.role?.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  const user: any = await strapi.db.query('admin::user').findOne({
    where: { id: userId },
    populate: { roles: { select: ['id', 'code'] } },
  });
  const roles: any[] = Array.isArray(user?.roles) ? user.roles : [];
  return roles.some(
    (role) =>
      role?.code === 'strapi-super-admin' || allowedRoleIds.has(Number(role?.id)),
  );
};

async function isSuperAdmin(
  strapi: Core.Strapi,
  userId: number,
): Promise<boolean> {
  const user: any = await strapi.db.query('admin::user').findOne({
    where: { id: userId },
    populate: { roles: { select: ['code'] } },
  });
  return (
    Array.isArray(user?.roles) &&
    user.roles.some((role: any) => role?.code === 'strapi-super-admin')
  );
}
