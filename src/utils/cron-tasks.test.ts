import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

function strapiHarness(
  documents: any[] = [],
  { poolUids = ['api::coupon.coupon'] }: { poolUids?: string[] } = {},
) {
  const update = vi.fn(async () => undefined);
  const findMany = vi.fn(async () => documents);
  return {
    strapi: {
      documents: vi.fn(() => ({ findMany, update })),
      // Only offer types carrying a pool relation take part in the
      // pool-exhaustion sweep.
      contentType: vi.fn((uid: string) => ({
        attributes: poolUids.includes(uid) ? { uniqueCouponPool: {} } : {},
      })),
      // The nightly job resolves database/*.js from the app root, exactly as
      // production does — see loadUniqueCodeIntegrity in config/cron-tasks.ts.
      dirs: { app: { root: process.cwd() } },
      db: { connection: undefined },
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

describe('content lifecycle cron — exhausted unique pools', () => {
  beforeEach(() => {
    mocks.enqueueStandaloneIsrEvent.mockReset();
    mocks.removeInactiveCuratedOfferRelations.mockReset();
    mocks.removeDisplayedTopPicksFromOrdered.mockReset();
    mocks.removeInactiveCuratedOfferRelations.mockResolvedValue(NO_CHANGES);
    mocks.removeDisplayedTopPicksFromOrdered.mockResolvedValue(NO_CHANGES);
  });

  /** Answers each sweep separately so filter routing is actually exercised. */
  function poolHarness(byPoolState: Record<string, any[]>) {
    const update = vi.fn(async () => undefined);
    const findMany = vi.fn(async ({ filters }: any) => {
      if (!filters?.uniqueCouponPool) return [];
      return filters.uniqueCouponPool.exhaustedAt?.$notNull
        ? (byPoolState.drained ?? [])
        : (byPoolState.restocked ?? []);
    });
    return {
      strapi: {
        documents: vi.fn(() => ({ findMany, update })),
        contentType: vi.fn((uid: string) => ({
          attributes:
            uid === 'api::coupon.coupon' ? { uniqueCouponPool: {} } : {},
        })),
        log: { info: vi.fn(), error: vi.fn() },
      } as any,
      findMany,
      update,
    };
  }

  it('expires a published unique coupon once its pool runs dry', async () => {
    const { strapi, update } = poolHarness({
      drained: [
        {
          documentId: 'coupon-dry',
          contentStatus: 'published',
          scheduledAt: null,
          expiresAt: '2027-01-01T00:00:00.000Z',
          publishedOn: '2026-07-20T00:00:00.000Z',
          couponType: 'unique',
          uniqueCouponPool: { exhaustedAt: '2026-07-30T00:00:00.000Z' },
        },
      ],
    });

    await cronTasks.scheduler.task({ strapi });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'coupon-dry',
        data: expect.objectContaining({ contentStatus: 'expired' }),
      }),
    );
  });

  it('republishes an expired unique coupon once its pool is restocked', async () => {
    const { strapi, update } = poolHarness({
      restocked: [
        {
          documentId: 'coupon-refilled',
          contentStatus: 'expired',
          scheduledAt: null,
          expiresAt: '2027-01-01T00:00:00.000Z',
          publishedOn: '2026-07-20T00:00:00.000Z',
          couponType: 'unique',
          uniqueCouponPool: { exhaustedAt: null },
        },
      ],
    });

    await cronTasks.scheduler.task({ strapi });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'coupon-refilled',
        data: expect.objectContaining({ contentStatus: 'published' }),
      }),
    );
  });

  it('bounds the restock sweep by expiresAt so date-expired offers are not rescanned forever', async () => {
    const { strapi, findMany } = poolHarness({});

    await cronTasks.scheduler.task({ strapi });

    const restock = findMany.mock.calls.find(
      ([args]: any) => args.filters?.uniqueCouponPool?.exhaustedAt?.$null,
    );
    expect(restock?.[0].filters.$and[0].$or).toEqual([
      { expiresAt: { $null: true } },
      { expiresAt: { $gt: expect.any(String) } },
    ]);
  });

  it('keeps relation conditions out of the date sweep disjunction', async () => {
    // An OR-of-EXISTS is the shape that inflated planner cost and tripped PG
    // JIT on public search; each sweep must stay a flat, narrow query.
    const { strapi, findMany } = poolHarness({});

    await cronTasks.scheduler.task({ strapi });

    const dateSweeps = findMany.mock.calls.filter(
      ([args]: any) => !args.filters?.uniqueCouponPool,
    );
    expect(dateSweeps.length).toBeGreaterThan(0);
    for (const [args] of dateSweeps) {
      expect(JSON.stringify(args.filters)).not.toContain('uniqueCouponPool');
    }
  });

  it('does not sweep pools for an offer type that has no pool relation', async () => {
    const { strapi, findMany } = poolHarness({});

    await cronTasks.scheduler.task({ strapi });

    const dealCalls = strapi.documents.mock.calls.filter(
      ([uid]: any) => uid === 'api::deal.deal',
    );
    // Deals get the date sweep only — one call, no pool sweeps.
    expect(dealCalls).toHaveLength(1);
    expect(findMany.mock.calls.filter(([args]: any) => args.filters?.uniqueCouponPool))
      .toHaveLength(2);
  });
});

describe('cron config is loadable from the compiled layout', () => {
  // THE BUG THIS PINS. `database/*.js` is CommonJS shared with the Knex
  // migrations, and tsconfig has no `allowJs`, so it is never emitted into
  // `dist/`. Production runs `dist/config/cron-tasks.js` while the helper stays
  // at `<app>/database/…`, so a relative require resolves to a path that does
  // not exist — and being top-level it throws at import, taking the whole cron
  // config with it. Vitest runs this file from SOURCE, where the relative path
  // happens to resolve, which is exactly why the test suite stayed green while
  // the build was broken.
  const source = readFileSync(
    resolve(__dirname, '../../config/cron-tasks.ts'),
    'utf8',
  );
  // Comments discuss the broken form on purpose; assert against code only.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '');

  it('never requires a database helper by relative path', () => {
    expect(code).not.toMatch(/require\(\s*['"]\.\.\/database\//u);
  });

  it('resolves database helpers from the application root instead', () => {
    expect(code).toContain('strapi.dirs.app.root');
    expect(code).toMatch(/join\(\s*strapi\.dirs\.app\.root/u);
  });

  it('does not load the helper at module import time', () => {
    // A top-level require fails the whole config module, not just the task.
    const beforeExport = code.slice(0, code.indexOf('export default'));
    expect(beforeExport).not.toMatch(/^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(/mu);
  });
});
