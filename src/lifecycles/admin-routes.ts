import type { Core } from '@strapi/strapi';

import {
  ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES,
} from '../api/entity-coupon-layout/services/entity-coupon-layout';

export const ADMIN_ROUTE_PREFIXES = [
  '/entity-deal-page',
  '/entity-coupon-layout',
  '/record-lock',
] as const;

export async function registerAdminRoutes(strapi: Core.Strapi): Promise<void> {
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
      {
        method: 'PUT',
        path: '/pages/:kind/:documentId',
        handler: 'api::entity-deal-page.entity-deal-page.adminUpdate',
        config: { policies: entityDealPageAdminPolicies },
      },
    ],
  } as any);

  // Register the coupon-layout RBAC action HERE (the user register
  // lifecycle), not in `bootstrap`.
  //
  // The admin plugin's own bootstrap runs before the user bootstrap
  // (Strapi.js: runPluginsLifecycles(BOOTSTRAP) then runUserLifecycles) and
  // calls cleanPermissionsInDatabase(), which deletes every permission row
  // whose action is not yet in the action provider. Registering in the user
  // bootstrap therefore let the cleanup delete the granted row first and
  // register the action immediately afterwards — so every grant survived
  // exactly until the next restart, including ones made by hand in
  // Settings → Roles. (bootstrap-permissions.ts's one-shot seed key exists
  // because of that history.)
  //
  // The user `register` lifecycle runs before all of that, and the provider
  // only refuses registration once `strapi.isLoaded` is set (after
  // bootstrap), so this is both early enough and allowed.
  await strapi.service('admin::permission').actionProvider.registerMany([
    ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES,
  ]);

  strapi.server.routes({
    type: 'admin',
    prefix: '/entity-coupon-layout',
    routes: [
      {
        method: 'GET',
        path: '/refresh/:outboxId',
        handler: 'api::entity-coupon-layout.entity-coupon-layout.refresh',
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
        handler: 'api::entity-coupon-layout.entity-coupon-layout.candidates',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'POST',
        path: '/:kind/:documentId/preview',
        handler: 'api::entity-coupon-layout.entity-coupon-layout.preview',
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
