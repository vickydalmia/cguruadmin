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
          }
        }
      }

      if (changed > 0) {
        strapi.log.info({
          event: 'content.expiry_status_updated',
          changed,
        });
      }

      // Also heals legacy/manual selections: scheduled, expired, and
      // published-but-past-expiry offers are physically disconnected from
      // Homepage / Deal of the Day curation and every entity's Top Pick
      // Coupons. Taxonomy relations on the Coupon/Deal remain untouched. This
      // runs even when no status changed in this tick, so a previous transient
      // failure is retried automatically on the next five-minute pass.
      let cleanup;
      try {
        cleanup = await removeInactiveCuratedOfferRelations(strapi, now);
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
        const promoted = await removeDisplayedTopPicksFromOrdered(strapi);
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
