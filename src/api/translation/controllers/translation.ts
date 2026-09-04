// Admin endpoints for the AI-translation subsystem (mounted on the ADMIN
// router by registerTranslationRoutes — src/api/*/routes cannot
// authenticate an admin session; see src/register/admin-routes.ts).
import type { Core } from '@strapi/strapi';
import { z } from 'zod';
import { localizedApiUids } from '../../../translation/backfill';
import {
  currentBackfillRun,
  startTranslationBackfill,
} from '../../../translation/backfill-run';
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

const backfillBodySchema = z.object({
  mode: z.enum(['all', 'repair']).default('all'),
  uids: z.array(z.string().trim().min(1)).min(1).optional(),
  locales: z.array(z.string().trim().min(1)).min(1).optional(),
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
}).strict();

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

  /**
   * Super-admin: start the catalogue backfill (idempotent, coalescing) or,
   * with `dryRun`, its cost estimate — in the background. The scan takes
   * minutes on a real catalogue, so the request answers 202 with the run
   * state at once; progress and the result arrive through `outboxStatus`
   * (`backfill`). One durable run per database at a time: a second request
   * while one is active answers 409 with that run's state instead of starting
   * another.
   */
  async backfill(ctx: any) {
    const parsed = backfillBodySchema.safeParse(ctx.request?.body ?? {});
    if (!parsed.success) {
      return badRequest(
        ctx,
        parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    const { uids, locales, force, dryRun, mode } = parsed.data;
    const knownUids = new Set([...localizedApiUids(strapi), 'ui-dictionary']);
    const requestedUids = uids ? [...new Set(uids)] : undefined;
    const unknownUid = requestedUids?.find((uid) => !knownUids.has(uid));
    if (unknownUid) {
      return badRequest(ctx, `Unknown localized content type: ${unknownUid}`);
    }
    const enabledLocaleCodes = new Set(
      (await enabledContentLocales(strapi)).map((locale) => locale.code),
    );
    const requestedLocales = locales ? [...new Set(locales)] : undefined;
    const unknownLocale = requestedLocales?.find(
      (locale) => !enabledLocaleCodes.has(locale),
    );
    if (unknownLocale) {
      return badRequest(ctx, `Target locale "${unknownLocale}" is not enabled.`);
    }
    if (!dryRun && !(await translationRuntimeActive(strapi))) {
      return badRequest(
        ctx,
        'Translation is not active on this deployment (Country Setup switch or TRANSLATION_* env missing).',
      );
    }
    const { started, run } = await startTranslationBackfill(strapi, {
      uids: requestedUids,
      locales: requestedLocales,
      force,
      dryRun,
      mode,
    });
    ctx.set('Cache-Control', 'private, no-store');
    if (!started) {
      ctx.status = 409;
      ctx.body = {
        error: 'A translation backfill is already running; wait for it to finish.',
        run,
      };
      return;
    }
    ctx.status = 202;
    ctx.body = { accepted: true, run };
  },

  /** Dispatcher + queue health, cost-today, backlog, and the backfill run. */
  async outboxStatus(ctx: any) {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = {
      ...(await getTranslationStatus()),
      backfill: await currentBackfillRun(strapi),
    };
  },
});
