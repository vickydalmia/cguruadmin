import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/offer-visibility', () => ({
  sanitizeOutput: vi.fn(async (_strapi, _ctx, _uid, value) => value),
}));

import { sanitizeOutput } from '../../../utils/offer-visibility';
import createController, { CONTACT_PAGE_POPULATE } from './custom';

describe('contact page aggregate controller', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the complete sanitized page from one document read', async () => {
    const page = { documentId: 'contact-1', title: 'Contact Us' };
    const findFirst = vi.fn().mockResolvedValue(page);
    const strapi = {
      documents: vi.fn(() => ({ findFirst })),
    } as any;
    const ctx = { send: vi.fn((payload: any) => payload), state: {} } as any;

    const response = await createController({ strapi }).contactPageFull(ctx);

    expect(findFirst).toHaveBeenCalledWith({
      populate: CONTACT_PAGE_POPULATE,
    });
    expect(sanitizeOutput).toHaveBeenCalledWith(
      strapi,
      ctx,
      'api::contact-page.contact-page',
      page,
    );
    expect(response).toEqual({ data: page });
  });

  it('returns data null when the single type has not been saved yet', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const strapi = {
      documents: vi.fn(() => ({ findFirst })),
    } as any;
    const ctx = { send: vi.fn((payload: any) => payload) } as any;

    const response = await createController({ strapi }).contactPageFull(ctx);

    expect(response).toEqual({ data: null });
  });
});
