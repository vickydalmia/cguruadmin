import { join } from 'node:path';

import { computeContentStatus } from '../src/utils/content-status';
import { enqueueStandaloneIsrEvent } from '../src/isr-outbox/runtime';
import { removeInactiveCuratedOfferRelations } from '../src/utils/curated-offer-cleanup';
import { removeDisplayedTopPicksFromOrdered } from '../src/utils/curated-offer-top-picks';

/**
 * Resolve from the application ROOT, not from this module's directory, and not
 * at import time.
 *
 * `database/*.js` is CommonJS shared with the Knex migrations, and `tsconfig`
 * has no `allowJs`, so those files are never emitted into `dist/`. Production
 * runs `dist/config/cron-tasks.js` while the helper stays at
 * `<app>/database/…`, so a relative `require('../database/…')` resolves to a
 * path that does not exist and throws at module load — taking the whole cron
 * config with it. `src/index.ts` resolves the same helper the same way for the
 * same reason.
 */
function loadUniqueCodeIntegrity(strapi: any) {
  return require(
    join(strapi.dirs.app.root, 'database', 'unique-code-integrity.js'),
  );
}

export default {
  scheduler: {
    task: async ({ strapi }: { strapi: any }) => {
      const now = new Date();
      let changed = 0;
      const changedOffers: Record<string, string[]> = {
        'api::coupon.coupon': [],
        'api::deal.deal': [],
      };

      for (const uid of [
        "api::coupon.coupon",
        "api::deal.deal",
      ] as const) {
        // Only offers that can draw from a pool need the exhaustion arm.
        const tracksUniquePool = Boolean(
          (strapi.contentType(uid) as any)?.attributes?.uniqueCouponPool,
        );

        const fields = [
          "documentId",
          "scheduledAt",
          "expiresAt",
          "contentStatus",
          "publishedOn",
          ...(tracksUniquePool ? ["couponType"] : []),
        ];
        const poolPopulate = tracksUniquePool
          ? { populate: { uniqueCouponPool: { fields: ["exhaustedAt"] } } }
          : {};

        const dateDriven = await strapi.documents(uid).findMany({
          fields,
          ...poolPopulate,
          filters: {
            $or: [
              {
                contentStatus: "scheduled",
                scheduledAt: { $lte: now.toISOString() },
              },
              {
                contentStatus: "published",
                expiresAt: { $lte: now.toISOString() },
              },
            ],
          },
        });

        // Deliberately SEPARATE queries rather than more `$or` arms above.
        // Folding relation conditions into a disjunction turns it into an
        // OR-of-EXISTS, the shape that inflated planner cost and tripped PG JIT
        // on public search. Each of these is a flat AND over indexed columns.
        const poolDriven = tracksUniquePool
          ? [
              // Pool ran dry: stop rendering an "unlock" CTA that can no longer
              // produce a code.
              ...(await strapi.documents(uid).findMany({
                fields,
                ...poolPopulate,
                filters: {
                  couponType: "unique",
                  contentStatus: "published",
                  uniqueCouponPool: { exhaustedAt: { $notNull: true } },
                },
              })),
              // Pool restocked: bring the offer back without an editor having
              // to touch each one. Bounded by expiresAt so the ever-growing
              // set of genuinely date-expired unique offers is not re-examined
              // every five minutes forever.
              ...(await strapi.documents(uid).findMany({
                fields,
                ...poolPopulate,
                filters: {
                  couponType: "unique",
                  contentStatus: "expired",
                  uniqueCouponPool: { exhaustedAt: { $null: true } },
                  $and: [
                    {
                      $or: [
                        { expiresAt: { $null: true } },
                        { expiresAt: { $gt: now.toISOString() } },
                      ],
                    },
                  ],
                },
              })),
            ]
          : [];

        const docs = [...dateDriven, ...poolDriven].filter(
          (doc, index, all) =>
            all.findIndex((other) => other.documentId === doc.documentId) === index,
        );

        for (const doc of docs) {
          const nextStatus = computeContentStatus({
            scheduledAt: doc.scheduledAt,
            expiresAt: doc.expiresAt,
            poolExhausted:
              doc.couponType === "unique" &&
              Boolean(doc.uniqueCouponPool?.exhaustedAt),
            now,
          });
          const shouldClearScheduledAt =
            doc.scheduledAt &&
            nextStatus === "published" &&
            new Date(doc.scheduledAt) <= now;
          // A scheduled offer going live NOW is new to the site now — stamp the
          // sort key so it surfaces at the top of "newest first" listings on its
          // go-live date, not its authoring date. Fill-only: an editor-set date
          // (or a backfilled one) is never overwritten.
          const shouldStampPublishedOn =
            nextStatus === "published" && !doc.publishedOn;

          if (
            doc.contentStatus !== nextStatus ||
            shouldClearScheduledAt ||
            shouldStampPublishedOn
          ) {
            await strapi.documents(uid).update({
              documentId: doc.documentId,
              data: {
                contentStatus: nextStatus,
                ...(shouldClearScheduledAt ? { scheduledAt: null } : {}),
                ...(shouldStampPublishedOn
                  ? { publishedOn: now.toISOString() }
                  : {}),
              },
            });
            changed += 1;
            changedOffers[uid].push(doc.documentId);
          }
        }
      }

      if (changed > 0) {
        strapi.log.info({
          event: 'content.expiry_status_updated',
          changed,
        });
      }

      // Target only offers whose lifecycle changed in this pass. The old job
      // loaded every curated relation on every entity every five minutes.
      // Nightly reconciliation below retains the full-scan safety net.
      let cleanup;
      try {
        cleanup = await removeInactiveCuratedOfferRelations(
          strapi,
          now,
          changedOffers,
        );
      } catch (err: any) {
        strapi.log.error({
          event: 'content.curated_offer_relations_cleanup_failed',
          error: err?.message ?? String(err),
        });
        return;
      }

      // Separate try/catch ON PURPOSE. The pass above has already COMMITTED
      // its disconnects; folding this one into the same block meant a failure
      // here discarded those results and returned without enqueuing anything,
      // leaving expired Coupons rendered until some unrelated write happened
      // to revalidate the page.
      //
      // Must run AFTER that disconnect: it is what promotes a buffer into a
      // displayed Top Pick slot, which is the main way a displayed pick ends
      // up sitting in `orderedCoupons` as well.
      try {
        const promoted = await removeDisplayedTopPicksFromOrdered(
          strapi,
          cleanup.affectedPaths,
        );
        cleanup = {
          removedSelections:
            cleanup.removedSelections + promoted.removedSelections,
          affectedPaths: [
            ...new Set([...cleanup.affectedPaths, ...promoted.affectedPaths]),
          ],
          requiresFullRevalidation:
            cleanup.requiresFullRevalidation ||
            promoted.requiresFullRevalidation,
        };
      } catch (err: any) {
        // Retried on the next pass; the expiry cleanup above still reports.
        strapi.log.error({
          event: 'content.displayed_top_pick_repair_failed',
          error: err?.message ?? String(err),
        });
      }

      if (cleanup.removedSelections > 0) {
        try {
          await enqueueStandaloneIsrEvent(strapi, {
            reason: 'inactive curated offer relations cleaned',
            payload: cleanup.requiresFullRevalidation
              ? { all: true, scopes: ['routes'] }
              : { paths: cleanup.affectedPaths },
          });
        } catch (err: any) {
          strapi.log.error({
            event: 'content.curated_offer_relations_revalidation_failed',
            removedSelections: cleanup.removedSelections,
            error: err?.message ?? String(err),
          });
        }

        strapi.log.info({
          event: 'content.curated_offer_relations_cleaned',
          removedSelections: cleanup.removedSelections,
          affectedPaths: cleanup.affectedPaths,
          fullRevalidation: cleanup.requiresFullRevalidation,
        });
      }
    },
    options: {
      rule: "*/5 * * * *",
    },
  },

  // Low-priority consistency event. The gateway makes every page logically
  // stale in O(1) and BullMQ converges in the background; no build runs here.
  nightlyIsrConsistency: {
    task: async ({ strapi }: { strapi: any }) => {
      // Both scans are guarded SEPARATELY, and both separately from the
      // consistency event below — same discipline as the five-minute job, for
      // the same reason. These two were prepended unguarded, so one scan
      // throwing silently cancelled the entire nightly sweep, including the
      // unconditional consistency event that has nothing to do with them.
      const NO_CHANGES = {
        removedSelections: 0,
        affectedPaths: [] as string[],
        requiresFullRevalidation: false,
      };

      // Redemption no longer maintains the pool counters inline (that write
      // would reserialize every concurrent claimer), so they are reconciled
      // here. This also catches a pool that drained and then saw no further
      // clicks, which the redeem path alone would never notice.
      try {
        const { recountPools, releaseExpiredClaimTokens } =
          loadUniqueCodeIntegrity(strapi);
        await recountPools(strapi.db.connection);
        // Stale claim tokens hold a permanent unique index the replay window
        // will never honour again — release them so a long-abandoned
        // activation can draw a fresh code instead of colliding.
        await releaseExpiredClaimTokens(strapi.db.connection);
      } catch (err: any) {
        strapi.log.error({
          event: 'content.nightly_pool_recount_failed',
          error: err?.message ?? String(err),
        });
      }

      let cleanup = NO_CHANGES;
      try {
        cleanup = await removeInactiveCuratedOfferRelations(strapi, new Date());
      } catch (err: any) {
        strapi.log.error({
          event: 'content.nightly_curated_cleanup_failed',
          error: err?.message ?? String(err),
        });
      }

      let conflicts = NO_CHANGES;
      try {
        conflicts = await removeDisplayedTopPicksFromOrdered(strapi);
      } catch (err: any) {
        strapi.log.error({
          event: 'content.nightly_displayed_top_pick_repair_failed',
          error: err?.message ?? String(err),
        });
      }

      const affectedPaths = [
        ...new Set([...cleanup.affectedPaths, ...conflicts.affectedPaths]),
      ];
      if (affectedPaths.length > 0) {
        await enqueueStandaloneIsrEvent(strapi, {
          reason: 'nightly curated offer reconciliation',
          payload:
            cleanup.requiresFullRevalidation ||
            conflicts.requiresFullRevalidation
              ? { all: true, scopes: ['routes'] }
              : { paths: affectedPaths },
        });
      }
      await enqueueStandaloneIsrEvent(strapi, {
        reason: 'nightly ISR consistency',
        payload: {
          all: true,
          scopes: [
            'routes',
            'redirects',
            'chrome',
            'insights',
            'error-page',
          ],
        },
      });
    },
    options: {
      rule: "30 3 * * *",
    },
  },
};
