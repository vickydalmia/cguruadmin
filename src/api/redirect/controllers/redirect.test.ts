import { describe, expect, it, vi } from 'vitest';

// Stand-in for factories.createCoreController that mirrors the real wiring
// (@strapi/core/dist/factories.js): the custom config object is created, then
// its prototype is set to the base controller, which is what makes
// `super.find(ctx)` in the override resolve to the core find. `baseFind`
// plays the core find: it reads whatever ctx.query the override forced and
// answers with the standard { data, meta.pagination } envelope.
const { baseFind } = vi.hoisted(() => ({
  baseFind: vi.fn(),
}));

vi.mock('@strapi/strapi', () => ({
  factories: {
    createCoreController: (_uid: string, cfg?: any) =>
      ({ strapi }: any) => {
        const instance = typeof cfg === 'function' ? cfg({ strapi }) : { ...(cfg ?? {}) };
        Object.setPrototypeOf(instance, { find: baseFind });
        return instance;
      },
  },
}));

import createRedirectController from './redirect';

const ENVELOPE = {
  data: [{ documentId: 'r1', from: '/old', to: '/new', statusCode: 301, active: true }],
  meta: { pagination: { page: 1, pageSize: 100, pageCount: 1, total: 1 } },
};

function makeController() {
  baseFind.mockResolvedValue(ENVELOPE);
  return (createRedirectController as any)({ strapi: {} });
}

describe('public redirect find controller', () => {
  it('forces the active-only filter even when the caller asks for inactive rows', async () => {
    const controller = makeController();
    const ctx = { query: { filters: { active: { $eq: 'false' } } } } as any;

    await controller.find(ctx);

    expect(baseFind).toHaveBeenCalledWith(ctx);
    expect(ctx.query.filters).toEqual({ active: { $eq: true } });
  });

  it('forces the fixed projection, so note (and any requested field) never leaves', async () => {
    const controller = makeController();
    const ctx = {
      query: { fields: ['note', 'from'], populate: '*', sort: 'note:desc' },
    } as any;

    await controller.find(ctx);

    expect(ctx.query.fields).toEqual(['from', 'to', 'statusCode', 'active']);
    expect(ctx.query.fields).not.toContain('note');
    // Caller sort and populate are discarded; the sort is the fixed total order
    // that keeps the consumer's page walk deterministic.
    expect(ctx.query.sort).toEqual({ from: 'asc' });
    expect(ctx.query).not.toHaveProperty('populate');
  });

  it('keeps the pagination the frontend consumer sends (page walk at 100/page)', async () => {
    const controller = makeController();
    const ctx = {
      query: {
        'fields[0]': 'from',
        filters: { active: { $eq: 'true' } },
        pagination: { page: '3', pageSize: '100' },
      },
    } as any;

    await controller.find(ctx);

    expect(ctx.query.pagination).toEqual({ page: 3, pageSize: 100 });
  });

  it('clamps hostile pagination and defaults a bare request to page 1 of 100', async () => {
    const controller = makeController();

    const bare = { query: {} } as any;
    await controller.find(bare);
    expect(bare.query.pagination).toEqual({ page: 1, pageSize: 100 });

    const hostile = { query: { pagination: { page: '-2', pageSize: '5000' } } } as any;
    await controller.find(hostile);
    expect(hostile.query.pagination).toEqual({ page: 1, pageSize: 100 });
  });

  it('returns the core envelope untouched', async () => {
    const controller = makeController();
    const ctx = { query: {} } as any;

    await expect(controller.find(ctx)).resolves.toBe(ENVELOPE);
  });
});
