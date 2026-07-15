import { describe, expect, it } from 'vitest';
import routes from './directory';

describe('directory route', () => {
  it('exposes a cached public aggregate endpoint', () => {
    expect(routes.routes).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/directories/:kind',
        handler: 'api::directory.directory.find',
        config: expect.objectContaining({ auth: false }),
      }),
    ]);
    expect(routes.routes[0]?.config.middlewares).toContainEqual({
      name: 'global::cache',
      config: { ttlMs: 60_000, keyByPath: true },
    });
  });
});
