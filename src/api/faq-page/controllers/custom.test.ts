import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/offer-visibility', () => ({
  sanitizeOutput: vi.fn(async (_strapi, _ctx, _uid, value) => value),
}));

import { sanitizeOutput } from '../../../utils/offer-visibility';
import createController, { FAQ_PAGE_POPULATE } from './custom';

describe('FAQ page aggregate controller', () => {
  const findFirst = vi.fn();
  const strapi = {
    documents: vi.fn(() => ({ findFirst })),
  } as any;

  beforeEach(() => vi.clearAllMocks());

  it('returns a successful null envelope before the single type is saved', async () => {
    findFirst.mockResolvedValue(null);
    const ctx = { send: vi.fn((value) => value), notFound: vi.fn() } as any;

    await createController({ strapi }).faqPageFull(ctx);

    expect(findFirst).toHaveBeenCalledWith({ populate: FAQ_PAGE_POPULATE });
    expect(ctx.send).toHaveBeenCalledWith({ data: null });
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(sanitizeOutput).not.toHaveBeenCalled();
  });

  it('fully populates, sanitizes and returns the saved page', async () => {
    const page = {
      heading: 'Frequently Asked Questions',
      categories: [{ title: 'Coupons', items: [] }],
    };
    findFirst.mockResolvedValue(page);
    const ctx = { send: vi.fn((value) => value) } as any;

    await createController({ strapi }).faqPageFull(ctx);

    expect(sanitizeOutput).toHaveBeenCalledWith(
      strapi,
      ctx,
      'api::faq-page.faq-page',
      page,
    );
    expect(ctx.send).toHaveBeenCalledWith({ data: page });
  });
});
