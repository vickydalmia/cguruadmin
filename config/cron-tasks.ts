import { computeContentStatus } from '../src/utils/content-status';
import { enqueue } from '../src/static-deployment/queue';

// NOTE on rebuilds: the scheduler flips offers through the Document Service,
// so every update below passes through the documents middleware in
// src/index.ts — which enqueues the correct surgical rebuild scope (the
// offer's related entity pages + homepage) automatically. No explicit
// enqueue is needed here. BUILD_HOOK_URL remains as an optional external
// ping (e.g. future CI) — unset it when unused.
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

  // Nightly full rebuild: the consistency net for everything surgical builds
  // deliberately leave stale (nav labels after entity renames, scopes lost to
  // restarts). See cguru-ui/docs/deployment-runbook.md §8.
  nightlyFullRebuild: {
    task: async ({ strapi }: { strapi: any }) => {
      enqueue(strapi, { full: true }, 'nightly consistency build');
    },
    options: {
      rule: "30 3 * * *",
    },
  },
};
