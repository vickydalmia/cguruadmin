import { describe, expect, it } from 'vitest';
import routes from './custom';

describe('ui-dictionary routes', () => {
  it('serves the public read cached by path and rate-limited', () => {
    expect(routes.routes).toContainEqual({
      method: 'GET',
      path: '/ui-dictionary',
      handler: 'ui-dictionary.find',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    });
  });

  it('keeps catalogue sync on Strapi token auth (auto scope) but admits only Custom tokens', () => {
    const push = routes.routes.find((route) => route.path === '/ui-dictionary/catalogue');
    expect(push).toMatchObject({
      method: 'POST',
      handler: 'ui-dictionary.syncCatalogue',
      config: {
        policies: ['global::content-api-custom-token-only'],
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 12, windowMs: 60_000 } },
        ],
      },
    });
    expect(push?.config).not.toHaveProperty('auth');
  });
});
