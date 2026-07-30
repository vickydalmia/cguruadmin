import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import createController from './offer-feedback';

function createHarness(result: any) {
  const feedbackService = {
    submitFeedback: vi.fn().mockResolvedValue(result),
  };
  const strapi = {
    service: vi.fn(() => feedbackService),
    config: { get: vi.fn(() => ['test-secret']) },
  } as any;
  const ctx = {
    params: { entityType: 'coupon', documentId: 'doc-1' },
    request: { body: { result: 'worked' }, ip: '203.0.113.1' },
    send: vi.fn((payload: any) => payload),
    badRequest: vi.fn((message: string) => message),
    notFound: vi.fn((message: string) => message),
    tooManyRequests: vi.fn((message: string) => message),
  };
  return { controller: createController({ strapi }), ctx, feedbackService };
}

describe('offer-feedback controller', () => {
  it('submits feedback with a salted IP hash and preserves the counts', async () => {
    const harness = createHarness({
      workedCount: 8,
      failedCount: 2,
      alreadyVoted: false,
    });

    await harness.controller.submit(harness.ctx as any);

    expect(harness.feedbackService.submitFeedback).toHaveBeenCalledWith(
      'coupon',
      'doc-1',
      'worked',
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
    expect(harness.ctx.send).toHaveBeenCalledWith({
      ok: true,
      workedCount: 8,
      failedCount: 2,
    });
  });

  it('rejects unsupported entity types', async () => {
    const harness = createHarness(null);
    harness.ctx.params.entityType = 'store';

    await harness.controller.submit(harness.ctx as any);

    expect(harness.ctx.badRequest).toHaveBeenCalledWith('Unsupported entity type');
    expect(harness.feedbackService.submitFeedback).not.toHaveBeenCalled();
  });

  it('rejects blank and oversized document ids', async () => {
    const harness = createHarness(null);
    harness.ctx.params.documentId = '   ';
    await harness.controller.submit(harness.ctx as any);
    expect(harness.ctx.badRequest).toHaveBeenCalledWith('Invalid document id');

    harness.ctx.params.documentId = 'x'.repeat(256);
    await harness.controller.submit(harness.ctx as any);
    expect(harness.ctx.badRequest).toHaveBeenCalledTimes(2);
    expect(harness.feedbackService.submitFeedback).not.toHaveBeenCalled();
  });

  it('rejects results other than worked/failed', async () => {
    const harness = createHarness(null);
    harness.ctx.request.body = { result: 'maybe' } as any;

    await harness.controller.submit(harness.ctx as any);

    expect(harness.ctx.badRequest).toHaveBeenCalledWith(
      'Feedback result must be "worked" or "failed"',
    );
    expect(harness.feedbackService.submitFeedback).not.toHaveBeenCalled();
  });

  it('returns 404 when the offer does not exist', async () => {
    const harness = createHarness(null);

    await harness.controller.submit(harness.ctx as any);

    expect(harness.ctx.notFound).toHaveBeenCalledWith('coupon not found');
    expect(harness.ctx.send).not.toHaveBeenCalled();
  });

  it('keeps duplicate votes on the established 429 path', async () => {
    const harness = createHarness({
      workedCount: 8,
      failedCount: 2,
      alreadyVoted: true,
    });

    await harness.controller.submit(harness.ctx as any);

    expect(harness.ctx.tooManyRequests).toHaveBeenCalledWith(
      'You have already left feedback for this offer.',
    );
    expect(harness.ctx.send).not.toHaveBeenCalled();
  });
});
