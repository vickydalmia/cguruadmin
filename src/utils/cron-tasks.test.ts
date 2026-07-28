import { beforeEach, describe, expect, it, vi } from 'vitest';

const NO_CHANGES = {
  removedSelections: 0,
  affectedPaths: [],
  requiresFullRevalidation: false,
};

const mocks = vi.hoisted(() => ({
  enqueueStandaloneIsrEvent: vi.fn(),
  removeInactiveCuratedOfferRelations: vi.fn(),
  removeDisplayedTopPicksFromOrdered: vi.fn(),
}));

vi.mock('../isr-outbox/runtime', () => ({
  enqueueStandaloneIsrEvent: mocks.enqueueStandaloneIsrEvent,
}));

vi.mock('./curated-offer-relations', () => ({
  removeInactiveCuratedOfferRelations:
    mocks.removeInactiveCuratedOfferRelations,
  removeDisplayedTopPicksFromOrdered: mocks.removeDisplayedTopPicksFromOrdered,
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
    mocks.removeDisplayedTopPicksFromOrdered.mockReset();
    mocks.removeDisplayedTopPicksFromOrdered.mockResolvedValue(NO_CHANGES);
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

  it('merges both cleanup passes into one revalidation, deduping paths', async () => {
    const { strapi } = strapiHarness();
    mocks.removeInactiveCuratedOfferRelations.mockResolvedValueOnce({
      removedSelections: 1,
      affectedPaths: ['/amazon/'],
      requiresFullRevalidation: false,
    });
    mocks.removeDisplayedTopPicksFromOrdered.mockResolvedValueOnce({
      removedSelections: 2,
      // '/amazon/' again: the expiry that promoted the buffer and the
      // promotion itself both touch the same page.
      affectedPaths: ['/amazon/', '/nike-coupons/'],
      requiresFullRevalidation: false,
    });

    await cronTasks.scheduler.task({ strapi });

    expect(mocks.enqueueStandaloneIsrEvent).toHaveBeenCalledWith(strapi, {
      reason: 'inactive curated offer relations cleaned',
      payload: { paths: ['/amazon/', '/nike-coupons/'] },
    });
    expect(strapi.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'content.curated_offer_relations_cleaned',
        removedSelections: 3,
      }),
    );
  });

  it('repairs promoted Top Picks only after the expiry disconnect has run', async () => {
    // Order matters: the expiry pass is what promotes a buffer into a shown
    // slot, which is the state the repair pass exists to clean up. Running it
    // first would miss exactly the case it was written for.
    const calls: string[] = [];
    const { strapi } = strapiHarness();
    mocks.removeInactiveCuratedOfferRelations.mockImplementationOnce(
      async () => {
        calls.push('inactive');
        return NO_CHANGES;
      },
    );
    mocks.removeDisplayedTopPicksFromOrdered.mockImplementationOnce(
      async () => {
        calls.push('promoted');
        return NO_CHANGES;
      },
    );

    await cronTasks.scheduler.task({ strapi });

    expect(calls).toEqual(['inactive', 'promoted']);
  });

  it('still revalidates the expiry cleanup when the repair pass throws', async () => {
    // The repair runs after the expiry disconnect has already COMMITTED. A
    // shared try/catch discarded those results and returned without enqueuing,
    // leaving expired Coupons rendered until an unrelated write revalidated.
    const { strapi } = strapiHarness();
    mocks.removeInactiveCuratedOfferRelations.mockResolvedValueOnce({
      removedSelections: 2,
      affectedPaths: ['/amazon/'],
      requiresFullRevalidation: false,
    });
    mocks.removeDisplayedTopPicksFromOrdered.mockRejectedValueOnce(
      new Error('repair unavailable'),
    );

    await expect(cronTasks.scheduler.task({ strapi })).resolves.toBeUndefined();

    expect(mocks.enqueueStandaloneIsrEvent).toHaveBeenCalledWith(strapi, {
      reason: 'inactive curated offer relations cleaned',
      payload: { paths: ['/amazon/'] },
    });
    expect(strapi.log.error).toHaveBeenCalledWith({
      event: 'content.displayed_top_pick_repair_failed',
      error: 'repair unavailable',
    });
  });

  it('escalates to full revalidation when either pass asks for it', async () => {
    const { strapi } = strapiHarness();
    mocks.removeInactiveCuratedOfferRelations.mockResolvedValueOnce(NO_CHANGES);
    mocks.removeDisplayedTopPicksFromOrdered.mockResolvedValueOnce({
      removedSelections: 1,
      affectedPaths: [],
      requiresFullRevalidation: true,
    });

    await cronTasks.scheduler.task({ strapi });

    expect(mocks.enqueueStandaloneIsrEvent).toHaveBeenCalledWith(strapi, {
      reason: 'inactive curated offer relations cleaned',
      payload: { all: true, scopes: ['routes'] },
    });
  });

  it('does not enqueue when neither pass changed anything', async () => {
    const { strapi } = strapiHarness();
    mocks.removeInactiveCuratedOfferRelations.mockResolvedValueOnce(NO_CHANGES);

    await cronTasks.scheduler.task({ strapi });

    expect(mocks.enqueueStandaloneIsrEvent).not.toHaveBeenCalled();
  });
});

describe('nightly ISR consistency cron', () => {
  beforeEach(() => {
    mocks.enqueueStandaloneIsrEvent.mockReset();
    mocks.removeInactiveCuratedOfferRelations.mockReset();
    mocks.removeDisplayedTopPicksFromOrdered.mockReset();
    mocks.removeDisplayedTopPicksFromOrdered.mockResolvedValue(NO_CHANGES);
    mocks.removeInactiveCuratedOfferRelations.mockResolvedValue(NO_CHANGES);
  });

  // The two reconciliation scans were prepended unguarded, so one of them
  // throwing cancelled the whole nightly sweep — including the consistency
  // event, which has nothing to do with curated relations.
  it('still enqueues the consistency event when a scan throws', async () => {
    const { strapi } = strapiHarness();
    mocks.removeInactiveCuratedOfferRelations.mockRejectedValueOnce(
      new Error('scan unavailable'),
    );

    await expect(
      cronTasks.nightlyIsrConsistency.task({ strapi }),
    ).resolves.toBeUndefined();

    expect(strapi.log.error).toHaveBeenCalledWith({
      event: 'content.nightly_curated_cleanup_failed',
      error: 'scan unavailable',
    });
    expect(mocks.enqueueStandaloneIsrEvent).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({ reason: 'nightly ISR consistency' }),
    );
  });

  it('isolates the two scans from each other', async () => {
    const { strapi } = strapiHarness();
    mocks.removeInactiveCuratedOfferRelations.mockResolvedValueOnce({
      removedSelections: 1,
      affectedPaths: ['/amazon/'],
      requiresFullRevalidation: false,
    });
    mocks.removeDisplayedTopPicksFromOrdered.mockRejectedValueOnce(
      new Error('repair unavailable'),
    );

    await expect(
      cronTasks.nightlyIsrConsistency.task({ strapi }),
    ).resolves.toBeUndefined();

    // The first scan's results still reach the outbox.
    expect(mocks.enqueueStandaloneIsrEvent).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({ payload: { paths: ['/amazon/'] } }),
    );
  });
});
