import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/offer-visibility', () => ({
  sanitizeOutput: vi.fn(async (_strapi, _ctx, _uid, value) => value),
}));

import createController, { PARTNER_WITH_US_PAGE_POPULATE } from './custom';

describe('partner with us page aggregate', () => {
  it('returns a stable null envelope before the single type is saved', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const controller = createController({
      strapi: { documents: vi.fn(() => ({ findFirst })) } as any,
    });
    const ctx = { send: vi.fn((payload: unknown) => payload) } as any;

    await expect(controller.partnerWithUsPageFull(ctx)).resolves.toEqual({
      data: null,
    });
    expect(findFirst).toHaveBeenCalledWith({
      populate: PARTNER_WITH_US_PAGE_POPULATE,
    });
  });

  it('fully populates nested media and sanitizes the public response', async () => {
    const page = { documentId: 'partner-page-1', title: 'Partner With Us Page' };
    const findFirst = vi.fn().mockResolvedValue(page);
    const strapi = { documents: vi.fn(() => ({ findFirst })) } as any;
    const controller = createController({ strapi });
    const ctx = { send: vi.fn((payload: unknown) => payload) } as any;

    await expect(controller.partnerWithUsPageFull(ctx)).resolves.toEqual({
      data: page,
    });
    expect(findFirst).toHaveBeenCalledWith({
      populate: PARTNER_WITH_US_PAGE_POPULATE,
    });
  });
});
