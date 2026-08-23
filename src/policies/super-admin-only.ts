import type { Core } from '@strapi/strapi';

// The admin-session strategy, registered by @strapi/admin for the `admin`
// router type. It is the ONLY strategy that puts an `admin::user` into
// `ctx.state.user`.
const ADMIN_SESSION_STRATEGY = 'admin';

/**
 * Application-level Super Admin guard for high-blast-radius settings APIs.
 *
 * This policy is only sound on an ADMIN-type route. `admin::isAuthenticatedAdmin`
 * is nothing more than `Boolean(state.isAuthenticated)` — it does NOT check
 * which strategy authenticated, and every strategy (api-token,
 * users-permissions, admin-token) sets that flag. On a content-API route
 * `state.user` is a `plugin::users-permissions.user`, and looking that id up in
 * the `admin::user` table below would compare two unrelated id spaces: a site
 * user whose numeric id happened to match a Super Admin's would pass.
 *
 * So assert the strategy explicitly and fail closed. Routes are registered in
 * src/register/admin-routes.ts via `strapi.server.routes({ type: 'admin', ... })`;
 * moving them
 * back under a per-API routes directory would silently make them content-API
 * again.
 *
 * Querying the persisted roles keeps the decision server-side; hiding a menu
 * item or relying on an assignable RBAC action would not make the endpoint
 * Super-Admin-only.
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

  const user: any = await strapi.db.query('admin::user').findOne({
    where: { id: userId },
    populate: { roles: { select: ['code'] } },
  });

  return Array.isArray(user?.roles)
    && user.roles.some((role: any) => role?.code === 'strapi-super-admin');
};
