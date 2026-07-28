import { describe, expect, it } from 'vitest';

import routes from './entity-deal-page';

describe('entity Deal-page routes', () => {
  it('keeps the public resolver readable and protects settings as Super Admin', () => {
    const publicRoute = routes.routes.find(
      (route) => route.path === '/entity-deal-pages/:dealSlug',
    );
    expect(publicRoute?.config).toMatchObject({ auth: false });
    expect(
      routes.routes.find(
        (route) => route.path === '/entity-deal-page-routes',
      )?.config,
    ).toMatchObject({ auth: false });

    for (const route of routes.routes.filter((item) =>
      item.path.startsWith('/admin/entity-deal-pages'),
    )) {
      expect(route.config.policies).toEqual([
        'admin::isAuthenticatedAdmin',
        'global::super-admin-only',
      ]);
    }
  });
});
