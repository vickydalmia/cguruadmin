import { afterEach, describe, expect, it, vi } from 'vitest';
import { setEnabledContentLocaleCodesForTest } from '../../../translation/locales/registry';
import createController from './search';

function harness(requestedLocale: string) {
  const search = vi.fn(async (request) => request);
  const service = {
    parseRequest: vi.fn(() => ({
      ok: true,
      value: {
        query: 'amazon',
        mode: 'preview',
        page: 1,
        pageSize: 20,
        locale: requestedLocale,
      },
    })),
    search,
  };
  const controller = createController({
    strapi: { service: () => service } as any,
  });
  const ctx = {
    query: { query: 'amazon', locale: requestedLocale },
    send: vi.fn((value) => value),
    badRequest: vi.fn(),
  } as any;
  return { controller, ctx, search };
}

describe('localized search controller', () => {
  afterEach(() => setEnabledContentLocaleCodesForTest([]));

  it('keeps an enabled Arabic locale', async () => {
    setEnabledContentLocaleCodesForTest(['ar']);
    const { controller, ctx, search } = harness('ar');

    await controller.search(ctx);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ locale: 'ar' }));
  });

  it('canonicalizes an unsupported locale to English', async () => {
    setEnabledContentLocaleCodesForTest(['ar']);
    const { controller, ctx, search } = harness('fr');

    await controller.search(ctx);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }));
  });
});
