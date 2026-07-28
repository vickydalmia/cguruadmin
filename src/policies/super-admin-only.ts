import type { Core } from '@strapi/strapi';

/**
 * Application-level Super Admin guard for high-blast-radius settings APIs.
 *
 * `admin::isAuthenticatedAdmin` must run before this policy. Querying the
 * persisted roles keeps the decision server-side; hiding a menu item or
 * relying on an assignable RBAC action would not make the endpoint
 * Super-Admin-only.
 */
export default async (
  policyContext: any,
  _config: unknown,
  { strapi }: { strapi: Core.Strapi },
): Promise<boolean> => {
  const userId = Number(policyContext?.state?.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;

  const user: any = await strapi.db.query('admin::user').findOne({
    where: { id: userId },
    populate: { roles: { select: ['code'] } },
  });

  return Array.isArray(user?.roles)
    && user.roles.some((role: any) => role?.code === 'strapi-super-admin');
};
