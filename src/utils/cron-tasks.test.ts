import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueStandaloneIsrEvent: vi.fn(),
  removeInactiveCuratedOfferRelations: vi.fn(),
}));

vi.mock('../isr-outbox/runtime', () => ({
  enqueueStandaloneIsrEvent: mocks.enqueueStandaloneIsrEvent,
}));

vi.mock('./curated-offer-relations', () => ({
  removeInactiveCuratedOfferRelations:
    mocks.removeInactiveCuratedOfferRelations,
}));

import cronTasks from '../../config/cron-tasks';

function strapiHarness(documents: any[] = []) {
  const update = vi.fn(async () => undefined);
  const findMany = vi.fn(async () => documents);
  return {
    strapi: {
      documents: vi.fn(() => ({ findMany, update })),
      log: {
        info: vi.fn(),
        error: vi.fn(),
      },
    } as any,
    findMany,
    update,
  };
}

describe('content lifecycle cron', () => {
  beforeEach(() => {
    mocks.enqueueStandaloneIsrEvent.mockReset();
    mocks.removeInactiveCuratedOfferRelations.mockReset();
  });

  it('preserves the status-update result when curated cleanup fails', async () => {
    const { strapi, update } = strapiHarness([
      {
        documentId: 'coupon-1',
        contentStatus: 'published',
        scheduledAt: null,
        expiresAt: '2026-07-25T00:00:00.000Z',
        publishedOn: '2026-07-20T00:00:00.000Z',
      },
    ]);
    mocks.removeInactiveCuratedOfferRelations.mockRejectedValueOnce(
      new Error('cleanup unavailable'),
    );

    await expect(
      cronTasks.scheduler.task({ strapi }),
    ).resolves.toBeUndefined();

    expect(update).toHaveBeenCalled();
    expect(strapi.log.info).toHaveBeenCalledWith({
      event: 'content.expiry_status_updated',
      changed: 2,
    });
    expect(strapi.log.error).toHaveBeenCalledWith({
      event: 'content.curated_offer_relations_cleanup_failed',
      error: 'cleanup unavailable',
    });
  });

  it('enqueues the exact affected paths after curated cleanup', async () => {
    const { strapi } = strapiHarness();
    mocks.removeInactiveCuratedOfferRelations.mockResolvedValueOnce({
      removedSelections: 3,
      affectedPaths: ['/', '/deal-of-the-day/', '/amazon/'],
      requiresFullRevalidation: false,
    });
    mocks.enqueueStandaloneIsrEvent.mockResolvedValueOnce({
      id: 'event-1',
      eventKey: 'event-key-1',
    });

    await cronTasks.scheduler.task({ strapi });

    expect(mocks.enqueueStandaloneIsrEvent).toHaveBeenCalledWith(strapi, {
      reason: 'inactive curated offer relations cleaned',
      payload: {
        paths: ['/', '/deal-of-the-day/', '/amazon/'],
      },
    });
    expect(strapi.log.info).toHaveBeenCalledWith({
      event: 'content.curated_offer_relations_cleaned',
      removedSelections: 3,
      affectedPaths: ['/', '/deal-of-the-day/', '/amazon/'],
      fullRevalidation: false,
    });
  });
});
