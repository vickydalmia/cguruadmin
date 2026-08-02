import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/offer-visibility', () => ({
  sanitizeOutput: vi.fn(async (_strapi, _ctx, _uid, value) => value),
}));

import createController, { TESTIMONIALS_PAGE_POPULATE } from './custom';

describe('testimonials page aggregate', () => {
  it('returns a stable null envelope before the single type is saved', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const controller = createController({
      strapi: { documents: vi.fn(() => ({ findFirst })) } as any,
    });
    const ctx = { send: vi.fn((payload: unknown) => payload) } as any;

    await expect(controller.testimonialsPageFull(ctx)).resolves.toEqual({
      data: null,
    });
    expect(findFirst).toHaveBeenCalledWith({
      populate: TESTIMONIALS_PAGE_POPULATE,
    });
  });

  it('fully populates portrait media before sanitizing the response', async () => {
    const page = { documentId: 'testimonials-1', title: 'Testimonials Page' };
    const findFirst = vi.fn().mockResolvedValue(page);
    const strapi = { documents: vi.fn(() => ({ findFirst })) } as any;
    const controller = createController({ strapi });
    const ctx = { send: vi.fn((payload: unknown) => payload) } as any;

    await expect(controller.testimonialsPageFull(ctx)).resolves.toEqual({
      data: page,
    });
    expect(findFirst).toHaveBeenCalledWith({
      populate: TESTIMONIALS_PAGE_POPULATE,
    });
  });
});
