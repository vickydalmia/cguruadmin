import type { Core } from '@strapi/strapi';

// The admin-session strategy, registered by @strapi/admin for the `admin`
// router type. It is the ONLY strategy that puts an `admin::user` into
// `ctx.state.user`.
const ADMIN_SESSION_STRATEGY = 'admin';

/**
 * Does the admin session behind `policyContext` hold the assignable RBAC
 * `action`? Shared by the policies that gate a feature on a per-role grant
 * made in Settings → Roles (translation.manage, ui-dictionary.manage).
 *
 * Only sound on an ADMIN-type route — the strategy assertion fails closed
 * everywhere else, for the reasons global::super-admin-only spells out.
 * Super Admins pass by construction: their role carries every registered
 * action, and while NO role holds the action yet (fresh deployment, before
 * the owner grants it) the endpoint stays Super-Admin-only rather than open.
 */
export async function adminHasRbacAction(
  strapi: Core.Strapi,
  policyContext: any,
  action: string,
): Promise<boolean> {
  if (policyContext?.state?.auth?.strategy?.name !== ADMIN_SESSION_STRATEGY) {
    return false;
  }
  const userId = Number(policyContext?.state?.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;

  const permissions: any[] = await strapi.db
    .query('admin::permission')
    .findMany({
      where: { action },
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
}

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
