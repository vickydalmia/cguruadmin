import type { Core } from '@strapi/strapi';
import { UI_DICTIONARY_ACTION } from '../api/ui-dictionary/controllers/ui-dictionary-admin';
import { adminHasRbacAction } from '../utils/admin-rbac-action';

/**
 * Gate for the Settings → UI Text endpoints: the assignable
 * `ui-dictionary.manage` RBAC action ("Edit storefront UI text"), granted
 * per role in Settings → Roles. Same strategy rules and same
 * "no grants yet → Super Admin only" fallback as translation-manage-only.
 * Triggering paid translation additionally needs translation.manage.
 */
export default (
  policyContext: any,
  _config: unknown,
  { strapi }: { strapi: Core.Strapi },
): Promise<boolean> => adminHasRbacAction(strapi, policyContext, UI_DICTIONARY_ACTION);
