import { describe, expect, it } from 'vitest';
import routes from './isr-status';

describe('ISR status route', () => {
  it('is private-by-secret and does not use public Strapi auth', () => {
    expect(routes.routes).toContainEqual({
      method: 'GET',
      path: '/isr/status',
      handler: 'isr-status.status',
      config: {
        auth: false,
        policies: ['global::isr-admin-auth'],
      },
    });
  });
});
