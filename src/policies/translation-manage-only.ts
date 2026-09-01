import type { Core } from '@strapi/strapi';
import { TRANSLATION_ACTION } from '../api/translation/controllers/translation';
import { adminHasRbacAction } from '../utils/admin-rbac-action';

/**
 * Gate for endpoints that trigger PAID LLM work per entry. Same
 * strategy-assertion rules as global::super-admin-only (only sound on an
 * admin-type route); the decision itself is the assignable
 * `translation.manage` RBAC action, so the owner can grant editors the
 * Translate button per role in Settings → Roles. Super Admins pass by
 * construction — their role carries every registered action.
 */
export default (
  policyContext: any,
  _config: unknown,
  { strapi }: { strapi: Core.Strapi },
): Promise<boolean> => adminHasRbacAction(strapi, policyContext, TRANSLATION_ACTION);
