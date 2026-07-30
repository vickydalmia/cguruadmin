import { describe, expect, it } from 'vitest';
import routes from './offer-feedback';

describe('offer-feedback routes', () => {
  it('registers the anonymous feedback POST with a rate limit and no cache', () => {
    const submit = routes.routes.find(
      (route) => route.path === '/offer-feedback/:entityType/:documentId',
    );

    expect(submit).toMatchObject({
      method: 'POST',
      handler: 'offer-feedback.submit',
      config: {
        auth: false,
        middlewares: [
          {
            name: 'global::rate-limit',
            config: { maxRequests: 10, windowMs: 60_000 },
          },
        ],
      },
    });
    expect(
      submit?.config.middlewares.some(
        (middleware: any) =>
          middleware === 'global::cache' || middleware?.name === 'global::cache',
      ),
    ).toBe(false);
  });
});
