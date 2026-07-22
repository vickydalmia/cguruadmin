import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/offer-visibility', () => ({
  sanitizeOutput: vi.fn(async (_strapi, _ctx, _uid, value) => value),
}));

import { sanitizeOutput } from '../../../utils/offer-visibility';
import createController from './custom';

describe('about page aggregate controller', () => {
  const findFirst = vi.fn();
  const strapi = {
    documents: vi.fn(() => ({ findFirst })),
  } as any;

  beforeEach(() => vi.clearAllMocks());

  it('returns a successful null envelope when the single type has not been saved', async () => {
    findFirst.mockResolvedValue(null);
    const ctx = {
      send: vi.fn((value) => value),
      notFound: vi.fn(),
    } as any;

    await createController({ strapi }).aboutPageFull(ctx);

    expect(ctx.send).toHaveBeenCalledWith({ data: null });
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(sanitizeOutput).not.toHaveBeenCalled();
  });

  it('sanitizes and returns a saved page', async () => {
    const page = { heading: 'About CouponzGuru' };
    findFirst.mockResolvedValue(page);
    const ctx = { send: vi.fn((value) => value) } as any;

    await createController({ strapi }).aboutPageFull(ctx);

    expect(sanitizeOutput).toHaveBeenCalledWith(
      strapi,
      ctx,
      'api::about-page.about-page',
      page,
    );
    expect(ctx.send).toHaveBeenCalledWith({ data: page });
  });
});
