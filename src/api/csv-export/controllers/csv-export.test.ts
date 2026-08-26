import { describe, expect, it, vi } from 'vitest';

import createController, { parseExportQuery } from './csv-export';

describe('parseExportQuery', () => {
  it('rejects anything that is not one of the six export targets', () => {
    expect(parseExportQuery('api::redirect.redirect', {})).toEqual({
      ok: false,
      status: 404,
      message: 'Unknown export target',
    });
    expect(parseExportQuery(undefined, {})).toMatchObject({ ok: false, status: 404 });
  });

  it('defaults to page 1 and the target page size', () => {
    expect(parseExportQuery('api::coupon.coupon', {})).toEqual({
      ok: true,
      uid: 'api::coupon.coupon',
      page: 1,
      pageSize: 250,
    });
    expect(parseExportQuery('api::bank.bank', undefined)).toMatchObject({ pageSize: 100 });
  });

  it('reads numeric query strings', () => {
    expect(parseExportQuery('api::store.store', { page: '4', pageSize: '50' })).toEqual({
      ok: true,
      uid: 'api::store.store',
      page: 4,
      pageSize: 50,
    });
  });

  it('refuses non-integer, zero, negative or oversized paging', () => {
    for (const page of ['0', '-1', 'abc', '1.5']) {
      expect(parseExportQuery('api::deal.deal', { page })).toMatchObject({ ok: false, status: 400 });
    }
    for (const pageSize of ['0', '501', 'x']) {
      expect(parseExportQuery('api::deal.deal', { pageSize })).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    expect(parseExportQuery('api::deal.deal', { pageSize: '500' })).toMatchObject({
      ok: true,
      pageSize: 500,
    });
  });
});

describe('csv-export controller', () => {
  function harness() {
    const exportPage = vi.fn(async (params: any) => ({ ...params, total: 1 }));
    const strapi = { service: vi.fn(() => ({ exportPage })) } as any;
    const ctx: any = {
      params: {},
      query: {},
      notFound: vi.fn((m: string) => ({ notFound: m })),
      badRequest: vi.fn((m: string) => ({ badRequest: m })),
      send: vi.fn((body: unknown) => body),
    };
    return { controller: createController({ strapi }), strapi, ctx, exportPage };
  }

  it('404s an unknown uid without touching the service', async () => {
    const { controller, ctx, exportPage } = harness();
    ctx.params.uid = 'api::job.job';
    await controller.page(ctx);
    expect(ctx.notFound).toHaveBeenCalledWith('Unknown export target');
    expect(exportPage).not.toHaveBeenCalled();
  });

  it('400s bad paging', async () => {
    const { controller, ctx, exportPage } = harness();
    ctx.params.uid = 'api::coupon.coupon';
    ctx.query = { pageSize: '9999' };
    await controller.page(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringContaining('pageSize'));
    expect(exportPage).not.toHaveBeenCalled();
  });

  it('sends the service page for a valid request', async () => {
    const { controller, ctx, exportPage, strapi } = harness();
    ctx.params.uid = 'api::brand.brand';
    ctx.query = { page: '2' };
    await controller.page(ctx);
    expect(strapi.service).toHaveBeenCalledWith('api::csv-export.csv-export');
    expect(exportPage).toHaveBeenCalledWith({ uid: 'api::brand.brand', page: 2, pageSize: 100 });
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ total: 1 }));
  });
});
