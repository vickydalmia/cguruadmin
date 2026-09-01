import { describe, expect, it, vi } from 'vitest';

import { registerAdminRuntimeConfigRoutes } from './admin-routes';

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
