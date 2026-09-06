/**
 * Client-side mirror of the server policy `global::super-admin-only`. Used
 * to hide Super-Admin-only controls (CSV export, Database Backups) from other
 * roles; it gates nothing by itself — the policy on the endpoint does.
 */
export const SUPER_ADMIN_ROLE_CODE = 'strapi-super-admin';

export function isSuperAdminUser(user: unknown): boolean {
  const roles = (user as any)?.roles;
  return (
    Array.isArray(roles) &&
    roles.some((role: any) => role?.code === SUPER_ADMIN_ROLE_CODE)
  );
}
