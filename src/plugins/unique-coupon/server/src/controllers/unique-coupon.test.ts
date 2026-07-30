import { describe, expect, it, vi } from 'vitest';

import uniqueCouponController, {
  MAX_CODES_PER_REQUEST,
  normalizeActivationId,
} from './unique-coupon';
import { DEFAULT_CHUNK_SIZE } from '../../../../../admin/utils/parse-codes';

function createHarness() {
  const importCodes = vi.fn(async (_poolDocumentId: string, codes: string[]) => ({
    imported: codes.length,
    skipped: 0,
    total: codes.length,
  }));
  const redeemCode = vi.fn(async () => ({ success: true, code: 'PROMO-1' }));
  const service = vi.fn(() => ({ importCodes, redeemCode }));
  const strapi = {
    plugin: vi.fn(() => ({ service })),
  } as any;
  const ctx = {
    request: { body: {} as any },
    badRequest: vi.fn((message: string) => ({ error: message })),
    notFound: vi.fn(),
    send: vi.fn((payload: any) => payload),
  };

  return {
    controller: uniqueCouponController({ strapi }),
    ctx,
    importCodes,
    redeemCode,
  };
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

describe('redeem activation id', () => {
  const uuid = 'b9d2c1a4-e5f6-4738-a1b2-c3d4e5f60718';
  const compact = 'b9d2c1a4e5f64738a1b2c3d4e5f60718';

  it('accepts both shapes the interstitial mints', () => {
    expect(normalizeActivationId(uuid)).toBe(uuid);
    expect(normalizeActivationId(compact)).toBe(compact);
    expect(normalizeActivationId(` ${compact} `)).toBe(compact);
  });

  it('ignores anything it cannot trust as an activation id', () => {
    // Dropped, never rejected: a malformed id must not cost the visitor their
    // code, it only means this activation cannot be replayed.
    for (const value of ['', 'not-a-uuid', 'x'.repeat(32), 42, null, undefined]) {
      expect(normalizeActivationId(value)).toBeNull();
    }
  });

  it('forwards a valid activation id to the service', async () => {
    const harness = createHarness();
    harness.ctx.request.body = { poolDocumentId: 'pool-1', activationId: uuid };

    await harness.controller.redeem(harness.ctx as any);

    expect(harness.redeemCode).toHaveBeenCalledWith('pool-1', {
      activationId: uuid,
    });
  });

  it('still redeems when no activation id is supplied', async () => {
    const harness = createHarness();
    harness.ctx.request.body = { poolDocumentId: 'pool-1' };

    await harness.controller.redeem(harness.ctx as any);

    expect(harness.redeemCode).toHaveBeenCalledWith('pool-1', {
      activationId: null,
    });
  });

  it('rejects a missing pool without calling the service', async () => {
    const harness = createHarness();
    harness.ctx.request.body = { activationId: uuid };

    await harness.controller.redeem(harness.ctx as any);

    expect(harness.ctx.badRequest).toHaveBeenCalled();
    expect(harness.redeemCode).not.toHaveBeenCalled();
  });
});
