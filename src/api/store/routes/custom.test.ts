import { describe, expect, it } from 'vitest';
import routes from './custom';

describe('entity-page routes', () => {
  it('registers related Store and rating endpoints for all four entity types', () => {
    const relatedStorePaths = routes.routes
      .filter((route) => route.method === 'GET' && route.path.endsWith('/related-stores'))
      .map((route) => route.path)
      .sort();
    const recommendationPaths = routes.routes
      .filter((route) => route.path.endsWith('/recommendations'));
    const ratingPaths = routes.routes
      .filter((route) => route.method === 'POST' && route.path.endsWith('/rating'))
      .map((route) => route.path)
      .sort();

    expect(relatedStorePaths).toEqual([
      '/banks/:slug/related-stores',
      '/brands/:slug/related-stores',
      '/categories/:slug/related-stores',
      '/stores/:slug/related-stores',
    ]);
    expect(recommendationPaths).toEqual([]);
    expect(ratingPaths).toEqual([
      '/banks/:slug/rating',
      '/brands/:slug/rating',
      '/categories/:slug/rating',
      '/stores/:slug/rating',
    ]);
  });
});
