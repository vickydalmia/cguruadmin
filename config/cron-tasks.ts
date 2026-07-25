import { computeContentStatus } from '../src/utils/content-status';
import { enqueueStandaloneIsrEvent } from '../src/isr-outbox/runtime';

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
