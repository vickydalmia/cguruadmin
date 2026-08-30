import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import { enabledContentLocaleCodesSync } from '../translation/locales/registry';

// Read actions whose result is a content payload. Counts are included so a
// localized list and its pagination totals agree.
const READ_ACTIONS = new Set(['findOne', 'findFirst', 'findMany', 'count']);

/**
 * One middleware instead of a locale parameter threaded through ~20 custom
 * controllers: a PUBLIC content-api GET carrying a valid `?locale=` has that
 * locale injected into every document-service read it triggers on localized
 * types, so /api/homepage-full?locale=ar (and every aggregate/entity
 * endpoint the storefront uses) serves the Arabic document with zero
 * per-controller code.
 *
 * Scope is deliberately tight:
 *  - only requests under /api/ (the admin panel and internal jobs manage
 *    locale explicitly and are never rewritten);
 *  - only GET/HEAD (a write must always say its locale itself);
 *  - only codes the deployment actually serves (registry ∩ Country Setup,
 *    boot-primed) or the default — anything else is ignored, so an invalid
 *    locale degrades to default-language content instead of a 400 surface
 *    for cache-busting abuse;
 *  - never overrides an explicit `params.locale` from the calling code.
 *
 * India/USA (no locales enabled) take the length-0 fast path on every read.
 */
export function installContentLocaleReadMiddleware(strapi: Core.Strapi): void {
  strapi.documents.use(async (context: any, next: any) => {
    if (!READ_ACTIONS.has(context.action)) return next();
    const enabled = enabledContentLocaleCodesSync();
    if (enabled.length === 0) return next();
    if (context.params?.locale !== undefined) return next();

    const ctx = strapi.requestContext.get();
    const method = ctx?.request?.method;
    if (
      !ctx?.request?.url?.startsWith('/api/') ||
      (method !== 'GET' && method !== 'HEAD')
    ) {
      return next();
    }
    const raw = ctx.request.query?.locale;
    const requested = Array.isArray(raw) ? raw[0] : raw;
    if (
      typeof requested !== 'string' ||
      (requested !== DEFAULT_CONTENT_LOCALE && !enabled.includes(requested))
    ) {
      return next();
    }
    const model = strapi.getModel(context.uid as any) as any;
    if (model?.pluginOptions?.i18n?.localized !== true) return next();

    context.params = { ...context.params, locale: requested };
    return next();
  });
}
