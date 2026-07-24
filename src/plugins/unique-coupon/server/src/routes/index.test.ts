import { describe, expect, it } from 'vitest';

import routes from './index';

const IMPORT_ACTION = 'plugin::unique-coupon.codes.import';

const routeFor = (path: string) =>
  (routes as any[]).find((route) => route.path === path);

describe('unique-coupon admin routes', () => {
  it.each(['/upload', '/stats/:poolDocumentId'])(
    'guards %s with authentication AND the import RBAC action',
    (path) => {
      const route = routeFor(path);
      expect(route).toBeDefined();

      const policies = route.config.policies;
      // Authentication alone would let ANY admin role import codes; the
      // hasPermissions policy is what makes the action grantable per role.
      expect(policies).toContain('admin::isAuthenticatedAdmin');
      expect(policies).toContainEqual({
        name: 'admin::hasPermissions',
        config: { actions: [IMPORT_ACTION] },
      });
    },
  );

  it('leaves the public redeem route rate-limited but unauthenticated', () => {
    const route = routeFor('/redeem');
    expect(route.config.auth).toBe(false);
    expect(route.config.policies).toEqual(['plugin::unique-coupon.rate-limit']);
  });
});
