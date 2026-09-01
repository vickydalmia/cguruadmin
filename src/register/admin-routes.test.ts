import { describe, expect, it, vi } from 'vitest';

import {
  registerAdminRuntimeConfigRoutes,
  registerCountrySetupRoutes,
  registerUiDictionaryRoutes,
} from './admin-routes';

describe('admin runtime config route', () => {
  it('is a read-only authenticated admin endpoint', () => {
    const routes = vi.fn();
    registerAdminRuntimeConfigRoutes({ server: { routes } } as any);

    expect(routes).toHaveBeenCalledWith({
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
    });
  });
});

describe('country setup routes', () => {
  it('keeps every route, including the language picker, Super Admin only', () => {
    const routes = vi.fn();
    registerCountrySetupRoutes({ server: { routes } } as any);

    const policies = ['admin::isAuthenticatedAdmin', 'global::super-admin-only'];
    expect(routes).toHaveBeenCalledWith({
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
        {
          method: 'GET',
          path: '/languages',
          handler: 'api::site-configuration.site-configuration.adminLanguages',
          config: { policies },
        },
      ],
    });
  });
});

describe('ui dictionary routes', () => {
  it('gates every route on ui-dictionary.manage and the paid trigger on translation.manage too', () => {
    const routes = vi.fn();
    registerUiDictionaryRoutes({ server: { routes } } as any);

    const policies = ['admin::isAuthenticatedAdmin', 'global::ui-dictionary-manage-only'];
    const handler = (action: string) => `api::ui-dictionary.ui-dictionary-admin.${action}`;
    expect(routes).toHaveBeenCalledWith({
      type: 'admin',
      prefix: '/ui-dictionary',
      routes: [
        { method: 'GET', path: '/status', handler: handler('status'), config: { policies } },
        { method: 'GET', path: '/entries', handler: handler('entries'), config: { policies } },
        { method: 'PUT', path: '/entries/:locale/:key', handler: handler('upsertEntry'), config: { policies } },
        { method: 'DELETE', path: '/entries/:locale/:key', handler: handler('deleteEntry'), config: { policies } },
        { method: 'POST', path: '/import', handler: handler('importMessages'), config: { policies } },
        { method: 'GET', path: '/export', handler: handler('exportMessages'), config: { policies } },
        {
          method: 'POST',
          path: '/translate',
          handler: handler('translate'),
          config: { policies: [...policies, 'global::translation-manage-only'] },
        },
      ],
    });
  });
});
