import { describe, expect, it, vi } from 'vitest';

import middleware from './country-content-visibility';

describe('country Content Manager visibility middleware', () => {
  it('filters successful Content Manager init responses', async () => {
    const findFirst = vi.fn(async () => null);
    const findMany = vi.fn(async () => []);
    const strapi = {
      documents: vi.fn(() => ({ findFirst, findMany })),
      log: { error: vi.fn() },
    } as any;
    const ctx: any = {
      method: 'GET',
      path: '/content-manager/init',
      status: 200,
      body: null,
    };
    const next = vi.fn(async () => {
      ctx.body = {
        data: {
          contentTypes: [
            { uid: 'api::homepage.homepage' },
            { uid: 'api::deal-of-the-day-page.deal-of-the-day-page' },
          ],
        },
      };
    });

    await middleware({}, { strapi })(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.body.data.contentTypes).toEqual([
      { uid: 'api::homepage.homepage' },
      {
        uid: 'api::deal-of-the-day-page.deal-of-the-day-page',
        isDisplayed: false,
      },
    ]);
  });

  it('leaves the admin usable when visibility loading fails', async () => {
    const error = new Error('database unavailable');
    const strapi = {
      documents: vi.fn(() => ({
        findFirst: vi.fn(async () => {
          throw error;
        }),
        findMany: vi.fn(async () => []),
      })),
      log: { error: vi.fn() },
    } as any;
    const originalBody = { data: { contentTypes: [{ uid: 'api::store.store' }] } };
    const ctx: any = {
      method: 'GET',
      path: '/content-manager/init',
      status: 200,
      body: originalBody,
    };

    await middleware({}, { strapi })(ctx, async () => undefined);

    expect(ctx.body).toBe(originalBody);
    expect(strapi.log.error).toHaveBeenCalledWith(
      expect.stringContaining('database unavailable'),
    );
  });
});
