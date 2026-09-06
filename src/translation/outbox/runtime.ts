import { readWorkerHeartbeat } from './worker-health';
import { runInBackground } from '../../background/execution-context';
import { onceOnCommit } from '../../utils/once-on-commit';
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
let pendingStops = 0;

/**
 * Enqueue eligibility is the site opt-in, independent of this process role.
 * A missing worker/provider is an observable backlog, never a lost editor save.
 */
export async function translationRuntimeActive(
  strapi: Core.Strapi,
): Promise<boolean> {
  return (await enabledContentLocales(strapi)).length > 0;
}

/** True while this process runs a dispatcher (started at boot or by hot-apply). */
export function translationOutboxRunning(): boolean {
  return dispatcher !== null && pendingStops === 0;
}

let lifecycle: Promise<void> = Promise.resolve();

function serializeLifecycle(work: () => Promise<void>): Promise<void> {
  const operation = lifecycle.then(() => runInBackground(work));
  lifecycle = operation.catch(() => {});
  return operation;
}

export function startTranslationOutbox(strapi: Core.Strapi): Promise<void> {
  return serializeLifecycle(() => startDispatcher(strapi));
}

async function startDispatcher(strapi: Core.Strapi): Promise<void> {
  if (dispatcher) return;
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

export function stopTranslationOutbox(): Promise<void> {
  pendingStops += 1;
  return serializeLifecycle(async () => {
    await dispatcher?.stop();
    dispatcher = null;
  }).finally(() => { pendingStops -= 1; });
}

export async function getTranslationStatus(strapi?: Core.Strapi) {
  if (strapi) {
    const enabled = await translationRuntimeActive(strapi);
    if (!enabled) return { ok: true, enabled: false, dispatcher: null, outbox: null };
    const [worker, outbox] = await Promise.all([
      readWorkerHeartbeat(strapi), translationStore(strapi).statusSummary(),
    ]);
    const config = translationConfigFromEnv();
    const limits = readTranslationOutboxConfig();
    const backlogAgeMs = outbox.oldestUndeliveredAt
      ? Date.now() - new Date(outbox.oldestUndeliveredAt).getTime() : 0;
    const backlogOverdue = backlogAgeMs >= limits.backlogAlertMs;
    return { enabled: true, ok: worker.healthy && !backlogOverdue && outbox.expiredProcessing === 0,
      dispatcher: { ...worker, running: worker.healthy, stopped: !worker.healthy,
        model: config?.model ?? null, provider: config?.provider ?? null,
        lastError: worker.healthy ? null : 'Translation worker heartbeat unavailable or unhealthy' },
      outbox: { ...outbox, dailyBudgetUsd: config?.dailyBudgetUsd || null,
        backlogAgeMs, backlogOverdue, backlogAlertMs: limits.backlogAlertMs },
    };
  }
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
      onCommit(onceOnCommit(strapi, () => wakeTranslationOutbox()));
    },
  );
}
