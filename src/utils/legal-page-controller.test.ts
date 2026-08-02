import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./offer-visibility', () => ({
  sanitizeOutput: vi.fn(async (_strapi, _ctx, _uid, value) => value),
}));

import { sanitizeOutput } from './offer-visibility';
import { LEGAL_PAGE_POPULATE, sendLegalPage } from './legal-page-controller';

describe('legal page aggregate controller helper', () => {
  const findFirst = vi.fn();
  const strapi = {
    documents: vi.fn(() => ({ findFirst })),
  } as any;
  const uid = 'api::privacy-policy-page.privacy-policy-page' as const;

  beforeEach(() => vi.clearAllMocks());

  it('returns a successful null envelope before a single type is saved', async () => {
    findFirst.mockResolvedValue(null);
    const ctx = { send: vi.fn((value) => value) } as any;

    await sendLegalPage(strapi, ctx, uid);

    expect(findFirst).toHaveBeenCalledWith({ populate: LEGAL_PAGE_POPULATE });
    expect(ctx.send).toHaveBeenCalledWith({ data: null });
    expect(sanitizeOutput).not.toHaveBeenCalled();
  });

  it('populates, permission-sanitizes and cleans section HTML on response', async () => {
    const page = {
      heading: 'Privacy Policy',
      sections: [{ title: 'Introduction', body: '<p onclick="x()">Hello</p>' }],
    };
    findFirst.mockResolvedValue(page);
    const ctx = { send: vi.fn((value) => value) } as any;

    await sendLegalPage(strapi, ctx, uid);

    expect(sanitizeOutput).toHaveBeenCalledWith(strapi, ctx, uid, page);
    expect(ctx.send).toHaveBeenCalledWith({
      data: {
        heading: 'Privacy Policy',
        sections: [{ title: 'Introduction', body: '<p>Hello</p>' }],
      },
    });
  });
});
