import { computeContentStatus } from '../src/utils/content-status';
import { enqueueStandaloneIsrEvent } from '../src/isr-outbox/runtime';
import {
  removeDisplayedTopPicksFromOrdered,
  removeInactiveCuratedOfferRelations,
} from '../src/utils/curated-offer-relations';

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
        const docs = await strapi.documents(uid).findMany({
          fields: [
            "documentId",
            "scheduledAt",
            "expiresAt",
            "contentStatus",
            "publishedOn",
          ],
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

        for (const doc of docs) {
          const nextStatus = computeContentStatus({
            scheduledAt: doc.scheduledAt,
            expiresAt: doc.expiresAt,
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
