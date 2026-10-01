import { describe, expect, it, vi } from 'vitest';
import createController from './custom';
import { FESTIVAL_POPULATE } from '../services/festival-content';

function harness(page: unknown) {
  const findFirst = vi.fn(async () => page);
  const sanitize = vi.fn(async (row) => row);
  const strapi = {
    documents: vi.fn(() => ({ findFirst })),
    contentType: vi.fn(() => ({})),
    contentAPI: { sanitize: { output: sanitize } },
  };
  const ctx = { query: {}, state: { auth: undefined }, send: vi.fn(), notFound: vi.fn() };
  return { findFirst, sanitize, ctx, controller: createController({ strapi: strapi as never }) };
}

describe('Festival aggregate', () => {
  it('returns the sanitized populated singleton', async () => {
    const page = { hero: { altText: 'Savings' } };
    const h = harness(page);
    await h.controller.festivalFull(h.ctx);
    expect(h.findFirst).toHaveBeenCalledWith({ locale: 'en', populate: FESTIVAL_POPULATE });
    expect(h.sanitize).toHaveBeenCalled();
    expect(h.ctx.send).toHaveBeenCalledWith({ data: page });
  });
  it('returns a missing-page response only when no singleton exists', async () => {
    const h = harness(null);
    await h.controller.festivalFull(h.ctx);
    expect(h.ctx.notFound).toHaveBeenCalled();
    expect(h.ctx.send).not.toHaveBeenCalled();
  });
  it('propagates temporary database failures', async () => {
    const h = harness(null);
    h.findFirst.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await expect(h.controller.festivalFull(h.ctx)).rejects.toThrow('temporarily unavailable');
    expect(h.ctx.notFound).not.toHaveBeenCalled();
  });
});
