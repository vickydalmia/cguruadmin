import { computeContentStatus } from '../src/utils/content-status';

export default {
  scheduler: {
    task: async ({ strapi }: { strapi: any }) => {
      const now = new Date();

      for (const uid of [
        "api::coupon.coupon",
        "api::deal.deal",
      ] as const) {
        const docs = await strapi.documents(uid).findMany({
          fields: ["documentId", "scheduledAt", "expiresAt", "contentStatus"],
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

          if (doc.contentStatus !== nextStatus || shouldClearScheduledAt) {
            await strapi.documents(uid).update({
              documentId: doc.documentId,
              data: {
                contentStatus: nextStatus,
                ...(shouldClearScheduledAt ? { scheduledAt: null } : {}),
              },
            });
          }
        }
      }
    },
    options: {
      rule: "*/5 * * * *",
    },
  },
};
