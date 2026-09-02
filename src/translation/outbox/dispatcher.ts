// Translation DISPATCHER: claims jobs from translation_outbox and runs the
// per-document pipeline — enablement check, editor-lock deference, budget
// stop, source load, hash gate, LLM translation, locale write, state
// bookkeeping. Lifecycle/lease/backoff discipline is the ISR dispatcher's
// (src/isr-outbox/dispatcher.ts), reshaped around jobs that cost money.
import type { Core } from '@strapi/strapi';
import type { TranslationConfig } from '../config';
import { usdForTokens } from '../cost';
import { TranslationError } from '../errors';
import { collectTranslatableLeaves } from '../field-map';
import { enabledContentLocales } from '../locales/registry';
import { createTranslationProvider } from '../provider';
import type { TranslationProvider } from '../provider/types';
import { sourceContentHash } from '../source-hash';
import { UI_DICTIONARY_UID } from '../ui-dictionary/constants';
import { processUiDictionaryJob } from '../ui-dictionary/translate-dictionary';
import { translationPromptFingerprint } from '../prompts';
import { translateEntryLeaves } from '../translate-entry';
import {
  deleteLocaleVersion,
  loadPopulatedEntry,
  writeLocaleVersion,
} from '../writer';
import type { TranslationOutboxConfig } from './config';
import { logTranslation } from './log';
import { TranslationOutboxStore, type TranslationJob } from './store';
import { DEFAULT_CONTENT_LOCALE } from '../../constants/content-locales';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const RELATION_RETRY_DELAY_MS = 5 * 60 * 1_000;

/**
 * Validation and SQL-integrity failures are deterministic publication
 * failures, not provider failures. Retrying them would buy the same
 * translation repeatedly while the target row continues to reject it.
 */
export function isPermanentTranslationWriteError(cause: unknown): boolean {
  let current: unknown = cause;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== 'object') return false;
    const error = current as Record<string, unknown>;
    const code = String(error.code ?? '');
    const status = Number(error.status ?? error.statusCode);
    if (
      error.name === 'ValidationError'
      || /^23\d{3}$/u.test(code)
      || status === 400
      || status === 409
      || status === 422
    ) {
      return true;
    }
    current = error.cause;
  }
  return false;
}

function msUntilNextUtcMidnight(now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60_000, next.getTime() - now.getTime());
}

export type JobOutcome =
  | { state: 'delivered'; notes?: string }
  | { state: 'skipped'; reason: string }
  | { state: 'deferred'; reason: string; delayMs: number }
  | { state: 'failed'; reason: string };

export class TranslationDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private nextCleanupAt = 0;
  private readonly store: TranslationOutboxStore;
  private readonly provider: TranslationProvider;
  private readonly startedAt = Date.now();
  private lastCycleCompletedAt = 0;
  private lastDeliveredAt = 0;
  private lastError: string | null = null;

  constructor(
    private readonly strapi: Core.Strapi,
    private readonly config: TranslationConfig,
    private readonly outboxConfig: TranslationOutboxConfig,
    provider?: TranslationProvider,
  ) {
    this.store = new TranslationOutboxStore(
      strapi,
      outboxConfig.leaseMs,
      outboxConfig.maxBackoffMs,
    );
    this.provider = provider ?? createTranslationProvider(config);
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
    logTranslation(this.strapi, 'info', 'translation.dispatcher_started', {
      provider: this.provider.name,
      model: this.config.model,
      pollMs: this.outboxConfig.pollMs,
      batchSize: this.outboxConfig.batchSize,
    });
  }

  wake(): void {
    if (this.stopped || this.running) return;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  getStore(): TranslationOutboxStore {
    return this.store;
  }

  async status() {
    const outbox = await this.store.statusSummary();
    const backlogAgeMs = outbox.oldestUndeliveredAt
      ? Date.now() - new Date(outbox.oldestUndeliveredAt).getTime()
      : 0;
    const backlogOverdue = backlogAgeMs >= this.outboxConfig.backlogAlertMs;
    return {
      ok:
        !this.stopped &&
        this.lastError === null &&
        outbox.expiredProcessing === 0 &&
        !backlogOverdue,
      dispatcher: {
        running: Boolean(this.running),
        stopped: this.stopped,
        startedAt: this.startedAt,
        lastCycleCompletedAt: this.lastCycleCompletedAt || null,
        lastDeliveredAt: this.lastDeliveredAt || null,
        lastError: this.lastError,
        provider: this.provider.name,
        model: this.config.model,
      },
      outbox: {
        ...outbox,
        dailyBudgetUsd: this.config.dailyBudgetUsd || null,
        backlogAgeMs,
        backlogAlertMs: this.outboxConfig.backlogAlertMs,
        backlogOverdue,
      },
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.runCycle().finally(() => {
        this.running = null;
        this.schedule(this.outboxConfig.pollMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    try {
      const now = Date.now();
      if (now >= this.nextCleanupAt) {
        this.nextCleanupAt = now + CLEANUP_INTERVAL_MS;
        const cutoff = new Date(
          now - this.outboxConfig.retentionDays * 24 * 60 * 60 * 1_000,
        );
        const deleted = await this.store.deleteDeliveredBefore(cutoff);
        if (deleted > 0) {
          logTranslation(this.strapi, 'info', 'translation.cleanup_completed', {
            deleted,
            retentionDays: this.outboxConfig.retentionDays,
          });
        }
      }
      await Promise.all(
        Array.from({ length: this.outboxConfig.batchSize }, () =>
          this.dispatchOne(),
        ),
      );
      this.lastError = null;
    } catch (cause) {
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      logTranslation(this.strapi, 'error', 'translation.dispatcher_cycle_failed', {
        error: this.lastError,
      });
    } finally {
      this.lastCycleCompletedAt = Date.now();
    }
  }

  private async dispatchOne(): Promise<boolean> {
    const job = await this.store.claim();
    if (!job) return false;
    let leaseLost = false;
    let heartbeatRunning = false;
    const heartbeatMs = Math.max(
      1_000,
      Math.min(30_000, Math.floor(this.outboxConfig.leaseMs / 3)),
    );
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || leaseLost) return;
      heartbeatRunning = true;
      void this.store
        .refreshLease(job)
        .then((owned) => {
          if (!owned) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    }, heartbeatMs);
    heartbeat.unref?.();
    const assertLease = async () => {
      if (leaseLost || !(await this.store.refreshLease(job))) {
        leaseLost = true;
        throw new TranslationError('TRANSLATION_LEASE_LOST', {
          detail: `job ${job.id} is no longer owned by this worker`,
        });
      }
    };
    let outcome: JobOutcome;
    let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    try {
      const result = await this.processJob(job, assertLease);
      outcome = result.outcome;
      usage = result.usage;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const retryable =
        !(error instanceof TranslationError) || error.retryable;
      outcome = retryable
        ? {
            state: 'deferred',
            reason: error.message,
            delayMs:
              error instanceof TranslationError &&
              error.code === 'TRANSLATION_BUDGET_EXCEEDED'
                ? msUntilNextUtcMidnight()
                : 0,
          }
        : { state: 'failed', reason: error.message };
    } finally {
      clearInterval(heartbeat);
    }

    if (outcome.state === 'delivered' || outcome.state === 'skipped') {
      const marked = await this.store.markDelivered(job);
      if (marked) {
        this.lastDeliveredAt = Date.now();
        logTranslation(this.strapi, 'info', 'translation.job_delivered', {
          jobId: job.id,
          eventKey: job.eventKey,
          kind: job.kind,
          skipped: outcome.state === 'skipped',
          reason:
            outcome.state === 'skipped' ? outcome.reason : outcome.notes,
          attemptCount: job.attemptCount,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costUsd: usage.costUsd,
        });
      }
      return true;
    }
    if (outcome.state === 'failed') {
      await this.store.markFailed(job, outcome.reason);
      logTranslation(this.strapi, 'error', 'translation.job_failed', {
        jobId: job.id,
        eventKey: job.eventKey,
        error: outcome.reason,
        alert: true,
      });
      return true;
    }
    const retry = await this.store.scheduleRetry(
      job,
      outcome.reason,
      outcome.delayMs > 0 ? outcome.delayMs : undefined,
    );
    if (retry.owned) {
      if (retry.superseded) {
        logTranslation(this.strapi, 'info', 'translation.job_superseded', {
          jobId: job.id,
          eventKey: job.eventKey,
          attemptCount: retry.attemptCount,
        });
        return true;
      }
      const level =
        retry.attemptCount >= this.outboxConfig.alertAfterAttempts
          ? 'error'
          : 'warn';
      logTranslation(this.strapi, level, 'translation.job_deferred', {
        jobId: job.id,
        eventKey: job.eventKey,
        error: outcome.reason,
        attemptCount: retry.attemptCount,
        retryInMs: retry.delayMs,
        alert: level === 'error',
      });
    }
    return true;
  }

  private async processJob(
    job: TranslationJob,
    assertLease: () => Promise<void> = async () => {},
  ): Promise<{
    outcome: JobOutcome;
    usage: { tokensIn: number; tokensOut: number; costUsd: number };
  }> {
    const noUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    await assertLease();

    // 1. Enablement can change between enqueue and claim — re-check.
    const locales = await enabledContentLocales(this.strapi);
    const locale = locales.find((entry) => entry.code === job.targetLocale);
    if (!locale) {
      return {
        outcome: { state: 'skipped', reason: 'locale no longer enabled' },
        usage: noUsage,
      };
    }

    // The UI-text dictionary has no document: its own tables are its memory
    // and it persists per key group. Everything below is per-entry work.
    if (job.uid === UI_DICTIONARY_UID) {
      return processUiDictionaryJob({
        strapi: this.strapi,
        provider: this.provider,
        config: this.config,
        store: this.store,
        job,
        locale,
        assertLease,
      });
    }

    // 2. Source of truth: the latest committed default-locale entry, deeply
    // populated. An editor merely holding the English form open is irrelevant:
    // unsaved changes enqueue nothing, and the next committed save coalesces a
    // fresh job without delaying this one.
    const model = this.strapi.getModel(job.uid as any) as any;
    const source = await loadPopulatedEntry(
      this.strapi,
      job.uid,
      job.documentId,
      DEFAULT_CONTENT_LOCALE,
    );
    if (!source) {
      // A default-locale delete is represented by a durable job so the
      // generated public locale cannot survive as an orphan page.
      await deleteLocaleVersion(
        this.strapi,
        job.uid,
        job.documentId,
        job.targetLocale,
      );
      await this.store.deleteState(job.uid, job.documentId, job.targetLocale);
      return {
        outcome: {
          state: 'skipped',
          reason: 'source document gone; generated locale removed',
        },
        usage: noUsage,
      };
    }

    const leaves = collectTranslatableLeaves(this.strapi, job.uid, source);
    const hash = sourceContentHash(
      leaves,
      translationPromptFingerprint(this.strapi, locale),
    );
    const state = await this.store.readState(
      job.uid,
      job.documentId,
      job.targetLocale,
    );
    // "Current" needs BOTH the hash match AND the stored translation memory:
    // a matching hash with no memory (a pre-memory ledger row, or a manually
    // edited table) must re-translate rather than rebuild — the old
    // rebuild-from-the-locale-row path silently wrote ENGLISH into the
    // locale after migrate:fresh truncated the content tables while this
    // ledger survived. The memory is also exactly what makes repeated fresh
    // migrations free: same English ⇒ same hash ⇒ rebuild from memory with
    // zero LLM calls.
    const memory = state?.translations ?? null;
    const memoryComplete =
      memory !== null &&
      leaves.every(
        (leaf) =>
          typeof memory[leaf.path] === 'string' &&
          memory[leaf.path].trim().length > 0,
      );
    const textCurrent =
      !job.force && state?.sourceHash === hash && memoryComplete;

    // 3. The language work — only when the source actually changed.
    let translations: ReadonlyMap<string, string>;
    let needsReview = false;
    let reviewNotes: string[] = [];
    let usage = noUsage;
    if (textCurrent) {
      // Text is current: rebuild the locale version (relations, structure,
      // and — after a fresh migration — the rows themselves) from the
      // durable memory, never from whatever the locale row currently holds.
      translations = new Map(Object.entries(memory!));
      needsReview = state?.needsReview === true;
      reviewNotes = state?.reviewNotes ? [state.reviewNotes] : [];
    } else {
      await assertLease();
      const result = await translateEntryLeaves(
        this.strapi,
        this.provider,
        this.config,
        locale,
        leaves,
        {
          uid: job.uid,
          contentType: model?.info?.displayName ?? job.uid,
          sourceLocale: DEFAULT_CONTENT_LOCALE,
          targetLocale: job.targetLocale,
        },
        (stage) =>
          this.store.providerAttemptHooks(
            job,
            this.config,
            this.provider.name,
            stage,
          ),
      );
      await assertLease();
      translations = result.translations;
      needsReview = result.needsReview;
      reviewNotes = result.reviewNotes;
      usage = {
        tokensIn: result.inputTokens,
        tokensOut: result.outputTokens,
        costUsd:
          Math.round(
            usdForTokens(this.config, result.inputTokens, result.outputTokens) *
              1_000_000,
          ) / 1_000_000,
      };
    }

    // 4. Re-read immediately before publication. A second English save can
    // land while the two AI passes are running; publishing the older result
    // even briefly would violate source-of-truth ordering. The newer save has
    // already queued its own job, so this one can finish as superseded.
    await assertLease();
    const latestSource = await loadPopulatedEntry(
      this.strapi,
      job.uid,
      job.documentId,
      DEFAULT_CONTENT_LOCALE,
    );
    if (!latestSource) {
      await deleteLocaleVersion(
        this.strapi,
        job.uid,
        job.documentId,
        job.targetLocale,
      );
      await this.store.deleteState(job.uid, job.documentId, job.targetLocale);
      return {
        outcome: {
          state: 'skipped',
          reason: 'source deleted during translation; generated locale removed',
        },
        usage,
      };
    }
    const latestLeaves = collectTranslatableLeaves(
      this.strapi,
      job.uid,
      latestSource,
    );
    const latestHash = sourceContentHash(
      latestLeaves,
      translationPromptFingerprint(this.strapi, locale),
    );
    if (latestHash !== hash) {
      return {
        outcome: {
          state: 'skipped',
          reason: 'superseded by a newer English save',
        },
        usage,
      };
    }

    // 5. Persist the locale version through the document pipeline.
    await assertLease();
    let skippedRelations: Awaited<ReturnType<typeof writeLocaleVersion>>;
    try {
      skippedRelations = await writeLocaleVersion(
        this.strapi,
        job.uid,
        job.documentId,
        job.targetLocale,
        latestSource,
        translations,
      );
    } catch (cause) {
      if (!isPermanentTranslationWriteError(cause)) throw cause;
      throw new TranslationError('TRANSLATION_WRITE_REJECTED', {
        cause,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    await assertLease();

    // 6. Bookkeeping — including the translation memory the next rebuild
    // (or the next fresh migration) reuses without an LLM call.
    await this.store.upsertState(job.uid, job.documentId, job.targetLocale, {
      sourceHash: hash,
      needsReview,
      reviewNotes: reviewNotes.length ? reviewNotes.join('\n').slice(0, 4_000) : null,
      lastError: null,
      translations: Object.fromEntries(translations),
    });

    // 7. Missing relation targets: text is saved, joins are partial. Retry
    // the (now hash-current, LLM-free) job a few times, then accept with a
    // note — the nightly sweep and the backfill's final wave converge it.
    if (skippedRelations.length > 0) {
      if (job.attemptCount < this.outboxConfig.relationRetryMax) {
        return {
          outcome: {
            state: 'deferred',
            reason: `${skippedRelations.length} relation target(s) missing in ${job.targetLocale}`,
            delayMs: RELATION_RETRY_DELAY_MS,
          },
          usage,
        };
      }
      return {
        outcome: {
          state: 'delivered',
          notes: `accepted with ${skippedRelations.length} unresolved relation target(s)`,
        },
        usage,
      };
    }
    return { outcome: { state: 'delivered' }, usage };
  }

}
