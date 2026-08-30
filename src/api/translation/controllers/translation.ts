// Admin endpoints for the AI-translation subsystem (mounted on the ADMIN
// router by registerTranslationRoutes — src/api/*/routes cannot
// authenticate an admin session; see src/register/admin-routes.ts).
import type { Core } from '@strapi/strapi';
import {
  enqueueTranslationBackfill,
  estimateTranslationBackfill,
  localizedApiUids,
} from '../../../translation/backfill';
import { enabledContentLocales } from '../../../translation/locales/registry';
import {
  enqueueStandaloneTranslationJob,
  getTranslationStatus,
  translationRuntimeActive,
} from '../../../translation/outbox/runtime';
import { entryTranslationStatus } from '../../../translation/status';

export const TRANSLATION_ACTION = 'admin::translation.manage';

export const TRANSLATION_ACTION_ATTRIBUTES = {
  section: 'settings',
  displayName: 'Trigger AI translations',
  uid: 'translation.manage',
  // Administration Panel permission on the core `admin` plugin — the same
  // registration rules as entity-coupon-layout.manage apply (register in
  // the user register lifecycle, never bootstrap).
  pluginName: 'admin',
  category: 'content management',
  subCategory: 'translation',
} as const;

function badRequest(ctx: any, message: string) {
  ctx.status = 400;
  ctx.body = { error: message };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /** Per-entry panel payload: one status row per enabled target locale. */
  async entryStatus(ctx: any) {
    const uid = String(ctx.params?.uid ?? '');
    const documentId = String(ctx.params?.documentId ?? '');
    if (!localizedApiUids(strapi).includes(uid)) {
      return badRequest(ctx, 'Unknown or non-localized content type.');
    }
    if (!documentId) return badRequest(ctx, 'documentId is required.');
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = await entryTranslationStatus(strapi, uid, documentId);
  },

  /** Manual "Translate now" / "Re-translate" from the edit-view panel. */
  async enqueue(ctx: any) {
    const { uid, documentId, targetLocale, force } = ctx.request?.body ?? {};
    if (!localizedApiUids(strapi).includes(String(uid))) {
      return badRequest(ctx, 'Unknown or non-localized content type.');
    }
    if (typeof documentId !== 'string' || !documentId) {
      return badRequest(ctx, 'documentId is required.');
    }
    if (!(await translationRuntimeActive(strapi))) {
      return badRequest(
        ctx,
        'Translation is not active on this deployment (Country Setup switch or TRANSLATION_* env missing).',
      );
    }
    const enabled = await enabledContentLocales(strapi);
    const locales =
      typeof targetLocale === 'string' && targetLocale
        ? enabled.filter((locale) => locale.code === targetLocale)
        : enabled;
    if (typeof targetLocale === 'string' && targetLocale && locales.length === 0) {
      return badRequest(ctx, `Target locale "${targetLocale}" is not enabled.`);
    }
    for (const locale of locales) {
      await enqueueStandaloneTranslationJob(strapi, {
        uid: String(uid),
        documentId,
        targetLocale: locale.code,
        kind: 'translate',
        force: force === true,
        reason: `manual ${force === true ? 're-translate' : 'translate'}`,
      });
    }
    ctx.body = { enqueued: locales.length, locales: locales.map((locale) => locale.code) };
  },

  /** Super-admin: enqueue the whole catalogue (idempotent, coalescing). */
  async backfill(ctx: any) {
    const { uids, locales, force, dryRun } = ctx.request?.body ?? {};
    if (dryRun === true) {
      ctx.body = await estimateTranslationBackfill(strapi, {
        uids: Array.isArray(uids) ? uids.map(String) : undefined,
        locales: Array.isArray(locales) ? locales.map(String) : undefined,
      });
      return;
    }
    if (!(await translationRuntimeActive(strapi))) {
      return badRequest(
        ctx,
        'Translation is not active on this deployment (Country Setup switch or TRANSLATION_* env missing).',
      );
    }
    ctx.body = await enqueueTranslationBackfill(strapi, {
      uids: Array.isArray(uids) ? uids.map(String) : undefined,
      locales: Array.isArray(locales) ? locales.map(String) : undefined,
      force: force === true,
    });
  },

  /** Dispatcher + queue health, cost-today, backlog. */
  async outboxStatus(ctx: any) {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = await getTranslationStatus();
  },
});
