// Translation RUNTIME: singleton lifecycle (start/wake/stop/status) wired
// from src/index.ts, plus the enqueue helpers the middleware, admin routes
// and crons share. Mirrors src/isr-outbox/runtime.ts.
import type { Core } from '@strapi/strapi';
import {
  translationConfigFromEnv,
  translationConfigProblem,
} from '../config';
import { enabledContentLocales } from '../locales/registry';
import { readTranslationOutboxConfig } from './config';
import { TranslationDispatcher } from './dispatcher';
import { logTranslation } from './log';
import {
  insertTranslationJob,
  TranslationOutboxStore,
  type TranslationJobInsert,
} from './store';

let dispatcher: TranslationDispatcher | null = null;

/**
 * Is the subsystem live on this deployment? Both gates must hold: the site
 * opted in (Country Setup) AND the env block parses. Used by the enqueue
 * path so disabled deployments never write a single outbox row.
 */
export async function translationRuntimeActive(
  strapi: Core.Strapi,
): Promise<boolean> {
  if (!dispatcher) return false;
  return (await enabledContentLocales(strapi)).length > 0;
}

/** True while this process runs a dispatcher (started at boot or by hot-apply). */
export function translationOutboxRunning(): boolean {
  return dispatcher !== null;
}

export async function startTranslationOutbox(strapi: Core.Strapi): Promise<void> {
  const outboxConfig = readTranslationOutboxConfig();
  if (!outboxConfig.enabled) {
    logTranslation(strapi, 'info', 'translation.dispatcher_disabled', {
      reason: process.env.TRANSLATION_OUTBOX_DISPATCHER_ENABLED?.trim()
        ? 'TRANSLATION_OUTBOX_DISPATCHER_ENABLED=false'
        : 'CRON_ENABLED=false fallback',
    });
    return;
  }
  const locales = await enabledContentLocales(strapi);
  const config = translationConfigFromEnv();
  if (locales.length === 0) {
    if (config) {
      logTranslation(strapi, 'info', 'translation.disabled', {
        reason:
          'site-configuration has translation disabled or no target locales',
      });
    }
    return;
  }
  if (!config) {
    // The site asked for translation but the env cannot deliver it: say so
    // LOUDLY and stay safely off — never half-run a paid pipeline.
    logTranslation(strapi, 'error', 'translation.misconfigured', {
      reason: translationConfigProblem(),
      locales: locales.map((locale) => locale.code),
      alert: true,
    });
    return;
  }
  const { configureTranslationConcurrency } = await import('../provider');
  configureTranslationConcurrency(config.concurrency);
  dispatcher = new TranslationDispatcher(
    strapi,
    config,
    outboxConfig,
  );
  dispatcher.start();
}

export function wakeTranslationOutbox(): void {
  dispatcher?.wake();
}

export async function stopTranslationOutbox(): Promise<void> {
  await dispatcher?.stop();
  dispatcher = null;
}

export async function getTranslationStatus() {
  if (!dispatcher) {
    return {
      ok: true,
      enabled: false,
      dispatcher: null,
      outbox: null,
    };
  }
  const status = await dispatcher.status();
  return { enabled: true, ...status };
}

/** The panel/status store — valid whether or not the dispatcher runs. */
export function translationStore(strapi: Core.Strapi): TranslationOutboxStore {
  const outboxConfig = readTranslationOutboxConfig();
  return (
    dispatcher?.getStore() ??
    new TranslationOutboxStore(
      strapi,
      outboxConfig.leaseMs,
      outboxConfig.maxBackoffMs,
    )
  );
}

/**
 * Standalone enqueue for callers OUTSIDE the document middleware (admin
 * routes, crons, entity-coupon-layout): own transaction, wake after commit.
 */
export async function enqueueStandaloneTranslationJob(
  strapi: Core.Strapi,
  input: TranslationJobInsert,
): Promise<void> {
  await strapi.db.transaction(
    async ({ trx, onCommit }: { trx: any; onCommit: (fn: () => void) => void }) => {
      await insertTranslationJob(trx, input);
      onCommit(() => wakeTranslationOutbox());
    },
  );
}
