import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueEntityRatingInvalidation: vi.fn(async () => undefined),
}));

vi.mock('../../../isr-outbox/entity-rating-invalidation', () => ({
  enqueueEntityRatingInvalidation: mocks.enqueueEntityRatingInvalidation,
}));

import createController from './custom';

function createHarness(result: any) {
  const entityService = {
    submitRating: vi.fn().mockResolvedValue(result),
    relatedStores: vi.fn().mockResolvedValue(result),
    entityPopularSearches: vi.fn().mockResolvedValue(result),
  };
  const strapi = {
    service: vi.fn(() => entityService),
    config: { get: vi.fn(() => ['test-secret']) },
  } as any;
  const ctx = {
    params: { kind: 'bank', slug: 'hdfc-bank' },
    query: {},
    state: { entityType: 'bank' },
    request: { body: { value: 5 }, ip: '203.0.113.1' },
    send: vi.fn((payload: any) => payload),
    badRequest: vi.fn((message: string) => message),
    notFound: vi.fn((message: string) => message),
    tooManyRequests: vi.fn((message: string) => message),
  };
  mocks.enqueueEntityRatingInvalidation.mockClear();
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
    expect(mocks.enqueueEntityRatingInvalidation).toHaveBeenCalledWith(
      expect.anything(),
      'bank',
      'hdfc-bank',
    );
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
    // A duplicate moved no aggregate, so it must not rebuild the page.
    expect(mocks.enqueueEntityRatingInvalidation).not.toHaveBeenCalled();
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

  it('serves the safe Popular Searches aggregate and rejects invalid kinds', async () => {
    const response = { groups: [] };
    const harness = createHarness(response);
    await harness.controller.entityPopularSearches(harness.ctx as any);
    expect(harness.entityService.entityPopularSearches).toHaveBeenCalledWith(
      'bank',
      'hdfc-bank',
    );
    expect(harness.ctx.send).toHaveBeenCalledWith(response);

    harness.ctx.params.kind = 'coupon';
    await harness.controller.entityPopularSearches(harness.ctx as any);
    expect(harness.ctx.badRequest).toHaveBeenCalledWith('Unsupported entity type');
  });
});
