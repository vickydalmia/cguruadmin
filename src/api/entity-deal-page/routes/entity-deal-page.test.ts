import { describe, expect, it } from 'vitest';

import routes from './entity-deal-page';

describe('entity Deal-page routes', () => {
  it('keeps the public resolvers readable', () => {
    const publicRoute = routes.routes.find(
      (route) => route.path === '/entity-deal-pages/:dealSlug',
    );
    expect(publicRoute?.config).toMatchObject({ auth: false });
    expect(
      routes.routes.find(
        (route) => route.path === '/entity-deal-page-routes',
      )?.config,
    ).toMatchObject({ auth: false });
  });

  // The settings endpoints are registered on the ADMIN router in src/index.ts.
  // Anything loaded from src/api/*/routes is forced to `type: 'content-api'`,
  // which cannot authenticate an admin session and would hand
  // super-admin-only a users-permissions user to look up in admin::user.
  it('exposes no settings routes on the content API', () => {
    expect(routes.routes).toHaveLength(2);
    for (const route of routes.routes) {
      expect(route.method).toBe('GET');
      expect(route.config).toMatchObject({ auth: false });
      expect(route.path).not.toContain('/admin');
    }
  });
});
