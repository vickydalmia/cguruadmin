import { describe, expect, it, vi } from 'vitest';

import uniqueCouponController, { MAX_CODES_PER_REQUEST } from './unique-coupon';
import { DEFAULT_CHUNK_SIZE } from '../../../../../admin/utils/parse-codes';

function createHarness() {
  const importCodes = vi.fn(async (_poolDocumentId: string, codes: string[]) => ({
    imported: codes.length,
    skipped: 0,
    total: codes.length,
  }));
  const service = vi.fn(() => ({ importCodes }));
  const strapi = {
    plugin: vi.fn(() => ({ service })),
  } as any;
  const ctx = {
    request: { body: {} as any },
    badRequest: vi.fn((message: string) => ({ error: message })),
    notFound: vi.fn(),
    send: vi.fn((payload: any) => payload),
  };

  return { controller: uniqueCouponController({ strapi }), ctx, importCodes };
}

const makeCodes = (count: number) =>
  Array.from({ length: count }, (_, index) => `CODE-${index}`);

describe('uploadCodes per-request cap', () => {
  it('matches the admin client chunk size, so every UI batch is accepted', () => {
    expect(MAX_CODES_PER_REQUEST).toBe(DEFAULT_CHUNK_SIZE);
  });

  it('rejects a request over the cap and tells the caller to chunk', async () => {
    const harness = createHarness();
    harness.ctx.request.body = {
      poolDocumentId: 'pool-1',
      codes: makeCodes(MAX_CODES_PER_REQUEST + 1),
    };

    await harness.controller.uploadCodes(harness.ctx as any);

    expect(harness.ctx.badRequest).toHaveBeenCalledWith(
      expect.stringMatching(/2,000/),
    );
    expect(harness.ctx.badRequest).toHaveBeenCalledWith(
      expect.stringMatching(/split .*chunks/i),
    );
    expect(harness.importCodes).not.toHaveBeenCalled();
  });

  it('still accepts a request of exactly the cap', async () => {
    const harness = createHarness();
    const codes = makeCodes(MAX_CODES_PER_REQUEST);
    harness.ctx.request.body = { poolDocumentId: 'pool-1', codes };

    const payload = await harness.controller.uploadCodes(harness.ctx as any);

    expect(harness.ctx.badRequest).not.toHaveBeenCalled();
    expect(harness.importCodes).toHaveBeenCalledWith('pool-1', codes);
    expect(payload).toMatchObject({
      success: true,
      imported: MAX_CODES_PER_REQUEST,
      total: MAX_CODES_PER_REQUEST,
    });
  });
});
