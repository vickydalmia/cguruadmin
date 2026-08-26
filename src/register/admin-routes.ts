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
