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
  it('preserves editorial order, removes dead offers, and normalizes coupon badge copy', async () => {
    const offer = { documentId: 'coupon', title: 'Sale', contentStatus: 'published', affiliateLink: 'https://example.com', offerText: 'Extra 20% Off' };
    const page = { offerSlider: { items: [
      { coupon: { ...offer } },
      { coupon: { ...offer, expiresAt: '2000-01-01' } },
      { coupon: { ...offer, documentId: 'coupon-b' } },
      { coupon: { ...offer, affiliateLink: 'javascript:alert(1)' } },
    ] } };
    const h = harness(page);
    await h.controller.festivalFull(h.ctx);
    expect(page.offerSlider.items.map((item) => item.coupon.documentId)).toEqual(['coupon', 'coupon-b']);
    expect(page.offerSlider.items[0].coupon?.offerText).toEqual(['Extra', '20%', 'Off']);
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
