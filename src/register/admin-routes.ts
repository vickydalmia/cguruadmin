import type { Core } from '@strapi/strapi';
import { CSV_EXPORT_ROUTE_PREFIX } from '../constants/csv-export';

// Entity Deal-page settings endpoints, mounted on the ADMIN router rather
// than under src/api/entity-deal-page/routes.
//
// registerAPIRoutes forces `type: 'content-api'` on every router loaded
// from src/api/*/routes, and `route.info.type` is what selects the auth
// strategy set. The content API serves only api-token and
// users-permissions, so an admin-panel session authenticating these routes
// there is impossible — and `ctx.state.user` would be a
// plugin::users-permissions.user, which super-admin-only must never look up
// against the unrelated admin::user id space.
//
// Registering in the user `register` lifecycle is safe: it runs before
// `server.initRouting()` (Strapi.register → Strapi.bootstrap). The admin
// router mounts with an empty prefix, so these serve at
// /entity-deal-page/pages — there is no /api segment.
export function registerEntityDealPageRoutes(strapi: Core.Strapi): void {
  const entityDealPageAdminPolicies = [
    'admin::isAuthenticatedAdmin',
    'global::super-admin-only',
  ];
  strapi.server.routes({
    type: 'admin',
    prefix: '/entity-deal-page',
    routes: [
      {
        method: 'GET',
        path: '/pages',
        handler: 'api::entity-deal-page.entity-deal-page.adminList',
        config: { policies: entityDealPageAdminPolicies },
      },
      {
        method: 'PATCH',
        path: '/pages/:kind/:documentId',
        handler: 'api::entity-deal-page.entity-deal-page.adminUpdate',
        config: { policies: entityDealPageAdminPolicies },
      },
      // Same handler under PUT. PATCH is the documented verb and the correct
      // one for a partial merge, but the admin panel's fetch client
      // (useFetchClient) only exposes get/post/put/del — no patch — and the
      // settings screen must not reimplement admin token handling just to
      // reach this endpoint. Both verbs merge; neither replaces.
      {
        method: 'PUT',
        path: '/pages/:kind/:documentId',
        handler: 'api::entity-deal-page.entity-deal-page.adminUpdate',
        config: { policies: entityDealPageAdminPolicies },
      },
    ],
  } as any);
}

// Coupon layout is deliberately outside Content Manager's generic
// relation update route. GET remains authenticated-only so restricted
// editors can see saved counts and an actionable disabled-state reason;
// the controller applies both the feature action and model read/update
// capability before candidates, preview or writes are allowed.
export function registerEntityCouponLayoutRoutes(strapi: Core.Strapi): void {
  strapi.server.routes({
    type: 'admin',
    prefix: '/entity-coupon-layout',
    routes: [
      {
        method: 'GET',
        path: '/refresh/:outboxId',
        handler:
          'api::entity-coupon-layout.entity-coupon-layout.refresh',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'GET',
        path: '/:kind/:documentId',
        handler: 'api::entity-coupon-layout.entity-coupon-layout.get',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'GET',
        path: '/:kind/:documentId/candidates',
        handler:
          'api::entity-coupon-layout.entity-coupon-layout.candidates',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'POST',
        path: '/:kind/:documentId/preview',
        handler:
          'api::entity-coupon-layout.entity-coupon-layout.preview',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'PUT',
        path: '/:kind/:documentId',
        handler: 'api::entity-coupon-layout.entity-coupon-layout.replace',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
    ],
  } as any);
}

// Edit-lock endpoints for the Content Manager edit view (RecordLockPanel
// in src/admin/features/record-lock/record-lock-panel.tsx). Admin router for the same
// reason as the entity-deal-page settings routes above: src/api/*/routes
// cannot authenticate an admin session.
export function registerRecordLockRoutes(strapi: Core.Strapi): void {
  strapi.server.routes({
    type: 'admin',
    prefix: '/record-lock',
    routes: [
      {
        method: 'POST',
        path: '/acquire',
        handler: 'api::record-lock.record-lock.acquire',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'POST',
        path: '/release',
        handler: 'api::record-lock.record-lock.release',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
    ],
  } as any);
}

// Full-collection CSV export for the Content Manager list views (the
// "Export CSV" button in src/admin/features/csv-export). Admin router for
// the same reason as above. Super Admin only — the download holds every
// field of every entry — and `global::super-admin-only` is what enforces it;
// the admin button merely hides itself for other roles.
export function registerCsvExportRoutes(strapi: Core.Strapi): void {
  strapi.server.routes({
    type: 'admin',
    prefix: CSV_EXPORT_ROUTE_PREFIX,
    routes: [
      {
        method: 'GET',
        path: '/:uid',
        handler: 'api::csv-export.csv-export.page',
        config: {
          policies: ['admin::isAuthenticatedAdmin', 'global::super-admin-only'],
        },
      },
    ],
  } as any);
}

/** Country onboarding is a Super-Admin deployment decision, not editorial content. */
export function registerCountrySetupRoutes(strapi: Core.Strapi): void {
  const policies = [
    'admin::isAuthenticatedAdmin',
    'global::super-admin-only',
  ];
  strapi.server.routes({
    type: 'admin',
    prefix: '/country-setup',
    routes: [
      {
        method: 'GET',
        path: '/',
        handler: 'api::site-configuration.site-configuration.adminFind',
        config: { policies },
      },
      {
        method: 'PUT',
        path: '/',
        handler: 'api::site-configuration.site-configuration.adminUpdate',
        config: { policies },
      },
      // Languages the translation picker may offer (ICU-resolvable ISO 639-1).
      {
        method: 'GET',
        path: '/languages',
        handler: 'api::site-configuration.site-configuration.adminLanguages',
        config: { policies },
      },
      // The full offer-country master registry the Country Setup picker
      // offers. The editor-facing ENABLED subset is served separately below —
      // this whole prefix is Super-Admin-only.
      {
        method: 'GET',
        path: '/offer-countries',
        handler: 'api::site-configuration.site-configuration.adminOfferCountries',
        config: { policies },
      },
    ],
  } as any);
}

/**
 * The enabled offer-country tags, for the Coupon/Deal edit form's picker.
 * Any authenticated admin: editors tag offers, and the list leaks nothing —
 * it is the same data `GET /api/site-settings` serves publicly.
 */
export function registerOfferCountryRoutes(strapi: Core.Strapi): void {
  strapi.server.routes({
    type: 'admin',
    prefix: '/offer-countries',
    routes: [
      {
        method: 'GET',
        path: '/options',
        handler:
          'api::site-configuration.site-configuration.adminEnabledOfferCountries',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
    ],
  } as any);
}

// AI-translation endpoints for the edit-view Translation panel and the
// super-admin backfill. Per-entry status is readable by any authenticated
// admin (the panel must render for editors); triggering paid LLM work
// additionally requires the translation.manage RBAC action, and the
// catalogue-wide backfill/estimate stays Super Admin only.
export function registerTranslationRoutes(strapi: Core.Strapi): void {
  strapi.server.routes({
    type: 'admin',
    prefix: '/translation',
    routes: [
      {
        method: 'GET',
        path: '/status/:uid/:documentId',
        handler: 'api::translation.translation.entryStatus',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'POST',
        path: '/enqueue',
        handler: 'api::translation.translation.enqueue',
        config: {
          policies: [
            'admin::isAuthenticatedAdmin',
            'global::translation-manage-only',
          ],
        },
      },
      {
        method: 'POST',
        path: '/backfill',
        handler: 'api::translation.translation.backfill',
        config: {
          policies: ['admin::isAuthenticatedAdmin', 'global::super-admin-only'],
        },
      },
      {
        method: 'POST',
        path: '/backfill/:id/cancel',
        handler: 'api::translation.translation.cancelBackfill',
        config: {
          policies: ['admin::isAuthenticatedAdmin', 'global::super-admin-only'],
        },
      },
      {
        method: 'GET',
        path: '/outbox-status',
        handler: 'api::translation.translation.outboxStatus',
        config: {
          policies: ['admin::isAuthenticatedAdmin', 'global::super-admin-only'],
        },
      },
    ],
  } as any);
}

/** Runtime deployment identity consumed by authenticated admin UI actions. */
export function registerAdminRuntimeConfigRoutes(strapi: Core.Strapi): void {
  strapi.server.routes({
    type: 'admin',
    prefix: '/admin-runtime-config',
    routes: [
      {
        method: 'GET',
        path: '/',
        handler: 'api::admin-runtime-config.admin-runtime-config.find',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
    ],
  } as any);
}

// Settings → UI Text: the storefront's UI-text dictionary (English overrides
// + every target language). Admin router for the same reason as above.
// Reading and editing need the assignable ui-dictionary.manage action; the
// paid translation trigger additionally needs translation.manage, exactly
// like the per-entry Translate button.
export function registerUiDictionaryRoutes(strapi: Core.Strapi): void {
  const policies = [
    'admin::isAuthenticatedAdmin',
    'global::ui-dictionary-manage-only',
  ];
  const handler = (action: string) => `api::ui-dictionary.ui-dictionary-admin.${action}`;
  strapi.server.routes({
    type: 'admin',
    prefix: '/ui-dictionary',
    routes: [
      { method: 'GET', path: '/status', handler: handler('status'), config: { policies } },
      { method: 'GET', path: '/entries', handler: handler('entries'), config: { policies } },
      {
        method: 'PUT',
        path: '/entries/:locale/:key',
        handler: handler('upsertEntry'),
        config: { policies },
      },
      {
        method: 'DELETE',
        path: '/entries/:locale/:key',
        handler: handler('deleteEntry'),
        config: { policies },
      },
      { method: 'POST', path: '/import', handler: handler('importMessages'), config: { policies } },
      { method: 'GET', path: '/export', handler: handler('exportMessages'), config: { policies } },
      {
        method: 'POST',
        path: '/translate',
        handler: handler('translate'),
        config: { policies: [...policies, 'global::translation-manage-only'] },
      },
    ],
  } as any);
}
