import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueStandaloneIsrEvent: vi.fn(async () => ({
    id: 'event-1',
    eventKey: 'key-1',
  })),
}));

vi.mock('./runtime', () => ({
  enqueueStandaloneIsrEvent: mocks.enqueueStandaloneIsrEvent,
}));

import { enqueueEntityRatingInvalidation } from './entity-rating-invalidation';

function createStrapi() {
  return { log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as any;
}

describe('enqueueEntityRatingInvalidation', () => {
  it('invalidates only the public path of the rated entity', async () => {
    mocks.enqueueStandaloneIsrEvent.mockClear();

    await enqueueEntityRatingInvalidation(createStrapi(), 'store', 'amazon');

    expect(mocks.enqueueStandaloneIsrEvent).toHaveBeenCalledWith(
      expect.anything(),
      {
        payload: { paths: ['/amazon/'] },
        reason: 'rating:store:amazon',
      },
    );
  });

  it('strips a stored type namespace so the event names the rendered route', async () => {
    mocks.enqueueStandaloneIsrEvent.mockClear();

    await enqueueEntityRatingInvalidation(
      createStrapi(),
      'category',
      'categories/fashions-coupons-offers',
    );

    expect(mocks.enqueueStandaloneIsrEvent).toHaveBeenCalledWith(
      expect.anything(),
      {
        payload: { paths: ['/fashions-coupons-offers/'] },
        reason: 'rating:category:fashions-coupons-offers',
      },
    );
  });

  it('never enqueues an empty path', async () => {
    mocks.enqueueStandaloneIsrEvent.mockClear();

    await enqueueEntityRatingInvalidation(createStrapi(), 'bank', '  ');

    expect(mocks.enqueueStandaloneIsrEvent).not.toHaveBeenCalled();
  });

  it('logs and swallows a delivery failure so the saved vote still returns 200', async () => {
    mocks.enqueueStandaloneIsrEvent.mockClear();
    mocks.enqueueStandaloneIsrEvent.mockRejectedValueOnce(
      new Error('outbox down'),
    );
    const strapi = createStrapi();

    await expect(
      enqueueEntityRatingInvalidation(strapi, 'brand', 'nike'),
    ).resolves.toBeUndefined();

    expect(strapi.log.error).toHaveBeenCalledWith(
      expect.stringContaining('isr.outbox.rating_enqueue_failed'),
    );
  });
});
