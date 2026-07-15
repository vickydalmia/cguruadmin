import { describe, expect, it, vi } from 'vitest';
import createController from './custom';

function createHarness(result: any) {
  const entityService = {
    submitRating: vi.fn().mockResolvedValue(result),
    relatedStores: vi.fn().mockResolvedValue(result),
  };
  const strapi = {
    service: vi.fn(() => entityService),
    config: { get: vi.fn(() => ['test-secret']) },
  } as any;
  const ctx = {
    params: { slug: 'hdfc-bank' },
    query: {},
    state: { entityType: 'bank' },
    request: { body: { value: 5 }, ip: '203.0.113.1' },
    send: vi.fn((payload: any) => payload),
    badRequest: vi.fn((message: string) => message),
    notFound: vi.fn((message: string) => message),
    tooManyRequests: vi.fn((message: string) => message),
  };
  return { controller: createController({ strapi }), ctx, entityService };
}

describe('entity-page controller', () => {
  it('submits a rating through the current entity type and preserves the response', async () => {
    const harness = createHarness({
      ratingAverage: 4.75,
      ratingCount: 12,
      alreadyVoted: false,
    });

    await harness.controller.submitRating(harness.ctx as any);

    expect(harness.entityService.submitRating).toHaveBeenCalledWith(
      'bank',
      'hdfc-bank',
      5,
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
    expect(harness.ctx.send).toHaveBeenCalledWith({
      ok: true,
      ratingAverage: 4.75,
      ratingCount: 12,
    });
  });

  it('keeps duplicate votes on the established 429 path', async () => {
    const harness = createHarness({
      ratingAverage: 4,
      ratingCount: 3,
      alreadyVoted: true,
    });

    await harness.controller.submitRating(harness.ctx as any);

    expect(harness.ctx.tooManyRequests).toHaveBeenCalledWith(
      'You have already rated this bank.',
    );
    expect(harness.ctx.send).not.toHaveBeenCalled();
  });

  it('loads related Stores through the entity-aware service', async () => {
    const response = { stores: [] };
    const harness = createHarness(response);

    await harness.controller.relatedStores(harness.ctx as any);

    expect(harness.entityService.relatedStores).toHaveBeenCalledWith(
      'bank',
      'hdfc-bank',
      {},
    );
    expect(harness.ctx.send).toHaveBeenCalledWith(response);
  });
});
