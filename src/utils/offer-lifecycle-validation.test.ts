import { describe, expect, it, vi } from 'vitest';
import {
  LIFECYCLE_WRITE_GRACE_MS,
  isOfferLifecycleUid,
  validateOfferLifecycle,
} from './offer-lifecycle-validation';

const NOW = new Date('2026-07-23T12:00:00.000Z');

const PAST = '2026-07-01T00:00:00.000Z';
const LATER_PAST = '2026-07-10T00:00:00.000Z';
const FUTURE = '2026-08-01T00:00:00.000Z';
const FAR_FUTURE = '2026-09-01T00:00:00.000Z';

function harness(stored: unknown = null) {
  const findOne = vi.fn().mockResolvedValue(stored);
  return {
    strapi: { documents: vi.fn(() => ({ findOne })) } as any,
    findOne,
  };
}

async function expectRejection(promise: Promise<unknown>, path: string) {
  await expect(promise).rejects.toMatchObject({
    name: 'ValidationError',
    details: { errors: expect.arrayContaining([expect.objectContaining({ path: [path] })]) },
  });
}

describe('offer lifecycle — derived contentStatus on create', () => {
  it.each(['api::coupon.coupon', 'api::deal.deal'] as const)(
    'derives published for %s with no dates',
    async (uid) => {
      const { strapi, findOne } = harness();
      const data: Record<string, unknown> = { title: 'New offer' };

      await validateOfferLifecycle(strapi, uid, 'create', data, undefined, false, NOW);

      expect(data.contentStatus).toBe('published');
      expect(findOne).not.toHaveBeenCalled();
    },
  );

  it('derives scheduled when scheduledAt is in the future', async () => {
    const { strapi } = harness();
    const data: Record<string, unknown> = { scheduledAt: FUTURE, expiresAt: FAR_FUTURE };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'create', data, undefined, false, NOW);

    expect(data.contentStatus).toBe('scheduled');
    expect(data.scheduledAt).toBe(FUTURE);
  });

  it('derives published when only a future expiresAt is set', async () => {
    const { strapi } = harness();
    const data: Record<string, unknown> = { expiresAt: FUTURE };

    await validateOfferLifecycle(strapi, 'api::deal.deal', 'create', data, undefined, false, NOW);

    expect(data.contentStatus).toBe('published');
  });

  it('ignores an editor-supplied contentStatus and overwrites it', async () => {
    const { strapi } = harness();
    const data: Record<string, unknown> = { contentStatus: 'published', scheduledAt: FUTURE };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'create', data, undefined, false, NOW);

    expect(data.contentStatus).toBe('scheduled');
  });
});

describe('offer lifecycle — entry guards', () => {
  it('rejects a past scheduledAt on create', async () => {
    const { strapi } = harness();

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'create',
        { scheduledAt: PAST },
        undefined,
        false, NOW,
      ),
      'scheduledAt',
    );
  });

  it('rejects a past expiresAt on create', async () => {
    const { strapi } = harness();

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::deal.deal',
        'create',
        { expiresAt: PAST },
        undefined,
        false, NOW,
      ),
      'expiresAt',
    );
  });

  it('rejects scheduledAt >= expiresAt when both are set', async () => {
    const { strapi } = harness();

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'create',
        { scheduledAt: FAR_FUTURE, expiresAt: FUTURE },
        undefined,
        false, NOW,
      ),
      'scheduledAt',
    );
  });

  it('rejects scheduledAt equal to expiresAt', async () => {
    const { strapi } = harness();

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'create',
        { scheduledAt: FUTURE, expiresAt: FUTURE },
        undefined,
        false, NOW,
      ),
      'scheduledAt',
    );
  });

  it('reports every problem in one ValidationError', async () => {
    const { strapi } = harness();

    await expect(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'create',
        { scheduledAt: PAST, expiresAt: LATER_PAST },
        undefined,
        false, NOW,
      ),
    ).rejects.toMatchObject({
      details: {
        errors: [
          expect.objectContaining({ path: ['scheduledAt'] }),
          expect.objectContaining({ path: ['expiresAt'] }),
        ],
      },
    });
  });

  it('rejects an editor moving scheduledAt into the past on update', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: FUTURE, expiresAt: FAR_FUTURE });

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'update',
        { scheduledAt: PAST },
        'c1',
        false, NOW,
      ),
      'scheduledAt',
    );
  });

  it('rejects a new expiresAt that lands before the stored scheduledAt', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: FAR_FUTURE,
      expiresAt: null,
    });

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'update',
        { expiresAt: FUTURE },
        'c1',
        false, NOW,
      ),
      'expiresAt',
    );
  });

  it('accepts a scheduledAt inside the write grace window and resolves it to now', async () => {
    const { strapi } = harness();
    const justPassed = new Date(NOW.getTime() - LIFECYCLE_WRITE_GRACE_MS / 2).toISOString();
    const data: Record<string, unknown> = { scheduledAt: justPassed, expiresAt: FUTURE };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'create', data, undefined, false, NOW);

    expect(data.contentStatus).toBe('published');
    expect(data.scheduledAt).toBeNull();
  });
});

describe('offer lifecycle — THE TRAP: partial cron updates', () => {
  it('keeps expired when the cron sends only { contentStatus: "expired" }', async () => {
    const { strapi, findOne } = harness({
      documentId: 'c1',
      scheduledAt: null,
      expiresAt: PAST,
    });
    const data: Record<string, unknown> = { contentStatus: 'expired' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    // Deriving from `data` alone would yield "published" here and flip every
    // expired offer back live on every five-minute tick.
    expect(data.contentStatus).toBe('expired');
    expect(data.contentStatus).not.toBe('published');
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'c1' }),
    );
  });

  it('does not reject the cron partial even though the stored expiresAt is past', async () => {
    const { strapi } = harness({ documentId: 'd1', scheduledAt: null, expiresAt: PAST });

    await expect(
      validateOfferLifecycle(
        strapi,
        'api::deal.deal',
        'update',
        { contentStatus: 'expired' },
        'd1',
        false, NOW,
      ),
    ).resolves.toBeUndefined();
  });

  it('agrees with the cron on the scheduled -> published flip', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });
    const data: Record<string, unknown> = { contentStatus: 'published', scheduledAt: null };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data.contentStatus).toBe('published');
    expect(data.scheduledAt).toBeNull();
  });

  it('handles stored Date objects, not just ISO strings', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: null,
      expiresAt: new Date(PAST),
    });
    const data: Record<string, unknown> = { contentStatus: 'expired' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data.contentStatus).toBe('expired');
  });
});

describe('offer lifecycle — clone source merge', () => {
  it('inherits future dates and keeps a scheduled clone scheduled', async () => {
    const { strapi, findOne } = harness({
      documentId: 'c1',
      scheduledAt: FUTURE,
      expiresAt: FAR_FUTURE,
    });
    const data: Record<string, unknown> = {};

    await validateOfferLifecycle(
      strapi,
      'api::coupon.coupon',
      'clone',
      data,
      'c1',
      false, NOW,
    );

    expect(data.contentStatus).toBe('scheduled');
    expect(data).not.toHaveProperty('scheduledAt');
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'c1' }),
    );
  });

  it('inherits an elapsed expiry and keeps an expired clone expired', async () => {
    const { strapi } = harness({
      documentId: 'd1',
      scheduledAt: null,
      expiresAt: PAST,
    });
    const data: Record<string, unknown> = {};

    await validateOfferLifecycle(
      strapi,
      'api::deal.deal',
      'clone',
      data,
      'd1',
      false, NOW,
    );

    expect(data.contentStatus).toBe('expired');
  });

  it('normalises an inherited elapsed schedule when the clone is now published', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: PAST,
      expiresAt: FUTURE,
    });
    const data: Record<string, unknown> = {};

    await validateOfferLifecycle(
      strapi,
      'api::coupon.coupon',
      'clone',
      data,
      'c1',
      false, NOW,
    );

    expect(data.contentStatus).toBe('published');
    expect(data.scheduledAt).toBeNull();
  });

  it('validates an explicit clone date override against the merged source', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: FUTURE,
      expiresAt: FAR_FUTURE,
    });

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'clone',
        { scheduledAt: PAST },
        'c1',
        false, NOW,
      ),
      'scheduledAt',
    );
  });
});

describe('offer lifecycle — grandfathering legacy rows', () => {
  it('lets an editor save an unrelated field on a row with a past scheduledAt', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW),
    ).resolves.toBeUndefined();
    expect(data.contentStatus).toBe('published');
  });

  it('lets an editor save an unrelated field on a row with a past expiresAt', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: null, expiresAt: PAST });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW),
    ).resolves.toBeUndefined();
    expect(data.contentStatus).toBe('expired');
  });

  it('lets an editor save a row whose stored scheduledAt >= expiresAt', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: FAR_FUTURE,
      expiresAt: FUTURE,
    });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW),
    ).resolves.toBeUndefined();
  });

  it('treats a re-sent identical scheduledAt as untouched', async () => {
    // The admin edit view posts the whole form back, so the past value is
    // present on every save of a legacy row.
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });
    const data: Record<string, unknown> = {
      title: 'Renamed',
      scheduledAt: PAST,
      expiresAt: FUTURE,
    };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW),
    ).resolves.toBeUndefined();
  });

  it('treats an ISO string re-send of a stored Date as untouched', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: new Date(PAST),
      expiresAt: null,
    });

    await expect(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'update',
        { scheduledAt: PAST },
        'c1',
        false, NOW,
      ),
    ).resolves.toBeUndefined();
  });

  it('still rejects when the editor genuinely edits a legacy past date', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'update',
        { scheduledAt: LATER_PAST },
        'c1',
        false, NOW,
      ),
      'scheduledAt',
    );
  });

  it('lets an editor clear a legacy past scheduledAt', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });
    const data: Record<string, unknown> = { scheduledAt: null };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW),
    ).resolves.toBeUndefined();
    expect(data.contentStatus).toBe('published');
  });
});

describe('offer lifecycle — normalisation (row 66)', () => {
  it('clears a past scheduledAt whenever the status resolves to published', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    // (published, past scheduledAt) is unrepresentable after this runs.
    expect(data.contentStatus).toBe('published');
    expect(data.scheduledAt).toBeNull();
  });

  it('leaves a future scheduledAt alone', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: FUTURE, expiresAt: FAR_FUTURE });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data.contentStatus).toBe('scheduled');
    expect(data).not.toHaveProperty('scheduledAt');
  });

  it('does not clear scheduledAt on an expired row', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: LATER_PAST });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data.contentStatus).toBe('expired');
    expect(data).not.toHaveProperty('scheduledAt');
  });
});

describe('offer lifecycle — publishedOn (the editor-controlled sort key)', () => {
  it('seeds publishedOn to now on a create that resolves to published', async () => {
    const { strapi } = harness();
    const data: Record<string, unknown> = { title: 'New offer' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'create', data, undefined, false, NOW);

    expect(data.contentStatus).toBe('published');
    expect(data.publishedOn).toBe(NOW.toISOString());
  });

  // A scheduled offer is new to the site on its GO-LIVE date, not its authoring
  // date — the scheduler stamps it then (config/cron-tasks.ts).
  it('leaves publishedOn unset on a create that resolves to scheduled', async () => {
    const { strapi } = harness();
    const data: Record<string, unknown> = { scheduledAt: FUTURE };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'create', data, undefined, false, NOW);

    expect(data.contentStatus).toBe('scheduled');
    expect(data).not.toHaveProperty('publishedOn');
  });

  it('never overwrites a publishedOn the editor set', async () => {
    const { strapi } = harness();
    const data: Record<string, unknown> = { publishedOn: LATER_PAST };

    await validateOfferLifecycle(strapi, 'api::deal.deal', 'create', data, undefined, false, NOW);

    expect(data.publishedOn).toBe(LATER_PAST);
  });

  it('leaves a stored publishedOn alone on update', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      expiresAt: FUTURE,
      publishedOn: LATER_PAST,
    });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data).not.toHaveProperty('publishedOn');
  });

  it('rejects a future publishedOn with an inline field error', async () => {
    const { strapi } = harness();

    await expectRejection(
      validateOfferLifecycle(
        strapi,
        'api::coupon.coupon',
        'create',
        { publishedOn: FUTURE },
        undefined,
        false,
        NOW,
      ),
      'publishedOn',
    );
  });

  // Same slack the past-date guards get: a date picked "now" and saved a moment
  // later must not read as future-dated. A slightly fast CLIENT clock is the
  // usual source, so the value is snapped to the server's now — otherwise two
  // offers bumped seconds apart would order by whose machine ran fastest.
  it('snaps a publishedOn inside the write-grace window to the server now', async () => {
    const { strapi } = harness();
    const data: Record<string, unknown> = {
      publishedOn: new Date(NOW.getTime() + LIFECYCLE_WRITE_GRACE_MS - 1000).toISOString(),
    };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'create', data, undefined, false, NOW),
    ).resolves.toBeUndefined();
    expect(data.publishedOn).toBe(NOW.toISOString());
  });

  it('leaves a past publishedOn exactly as the editor set it', async () => {
    const { strapi } = harness({ documentId: 'c1', expiresAt: FUTURE, publishedOn: PAST });
    const data: Record<string, unknown> = { publishedOn: LATER_PAST };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data.publishedOn).toBe(LATER_PAST);
  });

  // THE POINT OF THE FIELD: bumping reorders, it never revives.
  it('does not republish an expired offer when publishedOn is bumped', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: null,
      expiresAt: LATER_PAST,
      publishedOn: PAST,
    });
    const data: Record<string, unknown> = { publishedOn: NOW.toISOString() };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data.contentStatus).toBe('expired');
    expect(data.publishedOn).toBe(NOW.toISOString());
  });

  // The cron's partial payload carries no dates at all — it must not be read as
  // "publishedOn cleared" (see THE PARTIAL-PAYLOAD TRAP).
  it('leaves publishedOn untouched on the cron-shaped partial update', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      expiresAt: LATER_PAST,
      publishedOn: LATER_PAST,
    });
    const data: Record<string, unknown> = { contentStatus: 'expired' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data.contentStatus).toBe('expired');
    expect(data).not.toHaveProperty('publishedOn');
  });

  // Backfill-on-touch: a legacy row that never got a publishedOn gets one the
  // next time anything writes it, so it cannot sink below every seeded row.
  it('seeds publishedOn on an update to a published row that has none', async () => {
    const { strapi } = harness({ documentId: 'c1', expiresAt: FUTURE, publishedOn: null });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    expect(data.contentStatus).toBe('published');
    expect(data.publishedOn).toBe(NOW.toISOString());
  });
});

describe('offer lifecycle — STRICT clean-as-you-touch', () => {
  it('blocks a human save on a dirty untouched past scheduledAt (strict)', async () => {
    // Editor touches only `title`; the stored scheduledAt is already in the
    // past. Grandfathering (strict=false) lets this through; strict must not.
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await expectRejection(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', true, NOW),
      'scheduledAt',
    );
  });

  it('lets the cron pass the same dirty untouched past scheduledAt (strict=false)', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW),
    ).resolves.toBeUndefined();
    expect(data.contentStatus).toBe('published');
  });

  it('blocks a human save on a dirty untouched past expiresAt (strict)', async () => {
    const { strapi } = harness({ documentId: 'd1', scheduledAt: null, expiresAt: PAST });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await expectRejection(
      validateOfferLifecycle(strapi, 'api::deal.deal', 'update', data, 'd1', true, NOW),
      'expiresAt',
    );
  });

  it('blocks a human save on a dirty untouched scheduledAt >= expiresAt (strict)', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: FAR_FUTURE,
      expiresAt: FUTURE,
    });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await expectRejection(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', true, NOW),
      'scheduledAt',
    );
  });

  it('still passes a strict save when the effective dates are clean', async () => {
    const { strapi } = harness({
      documentId: 'c1',
      scheduledAt: FUTURE,
      expiresAt: FAR_FUTURE,
    });
    const data: Record<string, unknown> = { title: 'Renamed' };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', true, NOW),
    ).resolves.toBeUndefined();
    expect(data.contentStatus).toBe('scheduled');
  });

  it('lets a strict editor repair a dirty row by clearing the bad date', async () => {
    const { strapi } = harness({ documentId: 'c1', scheduledAt: PAST, expiresAt: FUTURE });
    const data: Record<string, unknown> = { scheduledAt: null };

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', true, NOW),
    ).resolves.toBeUndefined();
    expect(data.contentStatus).toBe('published');
    expect(data.scheduledAt).toBeNull();
  });
});

describe('offer lifecycle — fail-safes', () => {
  it('is a no-op for non-offer content types', async () => {
    const { strapi, findOne } = harness();
    const data: Record<string, unknown> = { scheduledAt: PAST };

    await validateOfferLifecycle(strapi, 'api::store.store', 'update', data, 's1', false, NOW);

    expect(data).not.toHaveProperty('contentStatus');
    expect(findOne).not.toHaveBeenCalled();
  });

  it('does nothing when the stored row cannot be read', async () => {
    const { strapi } = harness(null);
    const data: Record<string, unknown> = { contentStatus: 'expired' };

    await validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', data, 'c1', false, NOW);

    // Never derive from a partial payload without a merge base.
    expect(data.contentStatus).toBe('expired');
  });

  it('tolerates a missing or non-object payload', async () => {
    const { strapi } = harness();

    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'update', undefined, 'c1', false, NOW),
    ).resolves.toBeUndefined();
    await expect(
      validateOfferLifecycle(strapi, 'api::coupon.coupon', 'create', null, undefined, false, NOW),
    ).resolves.toBeUndefined();
  });

  it('exposes a uid type guard for the middleware', () => {
    expect(isOfferLifecycleUid('api::coupon.coupon')).toBe(true);
    expect(isOfferLifecycleUid('api::deal.deal')).toBe(true);
    expect(isOfferLifecycleUid('api::store.store')).toBe(false);
  });
});
