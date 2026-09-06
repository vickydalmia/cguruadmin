// Admin endpoints of the UI-text dictionary (Settings → UI Text), mounted on
// the ADMIN router by registerUiDictionaryRoutes — src/api/*/routes cannot
// authenticate an admin session (see src/register/admin-routes.ts). Thin:
// request → UiDictionaryAdminService → { data } | { error }.
import type { Core } from '@strapi/strapi';
import {
  UiDictionaryAdminError,
  UiDictionaryAdminService,
} from '../../../translation/ui-dictionary/admin-service';

export const UI_DICTIONARY_ACTION = 'admin::ui-dictionary.manage';

export const UI_DICTIONARY_ACTION_ATTRIBUTES = {
  section: 'settings',
  displayName: 'Edit storefront UI text',
  uid: 'ui-dictionary.manage',
  // Administration Panel permission on the core `admin` plugin — the same
  // registration rules as translation.manage apply (register in the user
  // register lifecycle, never bootstrap).
  pluginName: 'admin',
  category: 'content management',
  subCategory: 'translation',
} as const;

function adminUserId(ctx: any): number | null {
  const id = Number(ctx.state?.user?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function flag(raw: unknown): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === true || value === '1' || value === 'true';
}

async function respond(ctx: any, handler: () => Promise<unknown>): Promise<void> {
  ctx.set('Cache-Control', 'private, no-store');
  try {
    ctx.body = { data: await handler() };
  } catch (err) {
    if (!(err instanceof UiDictionaryAdminError)) throw err;
    ctx.status = err.status;
    ctx.body = err.details ? { error: err.message, details: err.details } : { error: err.message };
  }
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const service = () => new UiDictionaryAdminService(strapi);
  return {
    status: (ctx: any) => respond(ctx, () => service().status()),

    entries: (ctx: any) =>
      respond(ctx, () => service().entries(ctx.query?.locale, flag(ctx.query?.includeRemoved))),

    upsertEntry: (ctx: any) =>
      respond(ctx, () =>
        service().upsertEntry(
          ctx.params?.locale,
          ctx.params?.key,
          ctx.request?.body?.text,
          adminUserId(ctx),
        ),
      ),

    deleteEntry: (ctx: any) =>
      respond(ctx, () =>
        service().deleteEntry(ctx.params?.locale, ctx.params?.key, adminUserId(ctx)),
      ),

    importMessages: (ctx: any) =>
      respond(ctx, () => service().importMessages(ctx.request?.body, adminUserId(ctx))),

    exportMessages: (ctx: any) =>
      respond(ctx, () => service().exportMessages(ctx.query?.locale)),

    translate: (ctx: any) => respond(ctx, () => service().translate(ctx.request?.body)),
  };
};
