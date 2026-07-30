import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/offer-visibility', () => ({
  sanitizeOutput: vi.fn(async (_strapi, _ctx, _uid, value) => value),
}));

import createController, { PAGE_POPULATE } from './custom';

describe('career page aggregate controller', () => {
  const findFirst = vi.fn();
  const findMany = vi.fn();
  const strapi = {
    documents: vi.fn((uid: string) =>
      uid === 'api::career-page.career-page' ? { findFirst } : { findMany },
    ),
  } as any;

  beforeEach(() => vi.clearAllMocks());

  it('returns the page and only active sorted jobs in one response', async () => {
    findFirst.mockResolvedValue({ title: 'Careers' });
    findMany.mockResolvedValue([{ title: 'Designer', slug: 'designer', isActive: true }]);
    const ctx = { send: vi.fn((value) => value) } as any;

    await createController({ strapi }).careerPageFull(ctx);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      filters: { isActive: true },
      sort: ['sortOrder:asc', 'title:asc'],
    }));
    expect(PAGE_POPULATE.hero.populate).toEqual({
      image: true,
      highlights: true,
    });
    expect(ctx.send).toHaveBeenCalledWith({
      data: {
        page: { title: 'Careers' },
        jobs: [{ title: 'Designer', slug: 'designer', isActive: true }],
      },
    });
  });

  it('rejects malformed job slugs before querying content', async () => {
    const ctx = { params: { slug: '../admin' }, badRequest: vi.fn() } as any;
    await createController({ strapi }).jobFull(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith('Invalid job slug');
    expect(findMany).not.toHaveBeenCalled();
  });
});
