import { computeContentStatus } from '../src/utils/content-status';

// The frontend is a static build; status flips only become visible after a
// rebuild, so ping the CI build hook whenever the scheduler changes anything.
async function triggerRebuild(strapi: any) {
  const buildHookUrl = process.env.BUILD_HOOK_URL?.trim();
  if (!buildHookUrl) return;

  try {
    await fetch(buildHookUrl, { method: 'POST' });
    strapi.log.info('[scheduler] Triggered frontend rebuild via BUILD_HOOK_URL');
  } catch (error) {
    strapi.log.warn(`[scheduler] Failed to trigger frontend rebuild: ${error}`);
  }
}

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
            changed += 1;
          }
        }
      }

      if (changed > 0) {
        await triggerRebuild(strapi);
      }
    },
    options: {
      rule: "*/5 * * * *",
    },
  },
};
