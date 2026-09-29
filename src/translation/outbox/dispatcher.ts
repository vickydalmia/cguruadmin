import { fieldFingerprints, selectTranslationFields } from '../field-memory';
import { withLocalePublication } from '../publication-limit';
import { runInBackground } from '../../background/execution-context';
import { randomUUID } from 'node:crypto';
// Translation DISPATCHER: claims jobs from translation_outbox and runs the
// per-document pipeline — enablement check, editor-lock deference, budget
// stop, source load, hash gate, LLM translation, locale write, state
// bookkeeping. Lifecycle/lease/backoff discipline is the ISR dispatcher's
// (src/isr-outbox/dispatcher.ts), reshaped around jobs that cost money.
import type { Core } from '@strapi/strapi';
import type { TranslationConfig } from '../config';
import { usdForTokens } from '../cost';
import { TranslationError } from '../errors';
import {
  collectTranslatableLeaves,
  resolveRelationDependencies,
  type RelationDependency,
} from '../field-map';
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
  inspectLocaleVersion,
  loadPopulatedEntry,
  TranslationDependencyBlockedError,
  writeLocaleVersion,
} from '../writer';
import type { TranslationOutboxConfig } from './config';
import { logTranslation } from './log';
import { TRANSLATION_NIGHTLY_CONSISTENCY_REASON } from './reasons';
import { TranslationOutboxStore, type TranslationJob } from './store';
import { DEFAULT_CONTENT_LOCALE } from '../../constants/content-locales';
import { translationSourceIneligible } from '../eligibility';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEPENDENCY_RECONCILE_INTERVAL_MS = 60_000;

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

function isQualityGateFailure(error: unknown): boolean {
  return (
    error instanceof TranslationError &&
    error.code === 'TRANSLATION_QUALITY_GATE_FAILED'
  );
}

export function shouldRetryTranslationFailure(
  error: unknown,
  priorRetries: number,
  qualityRetryMax: number,
): boolean {
  if (!(error instanceof TranslationError)) return true;
  if (!error.retryable) return false;
  if (isQualityGateFailure(error)) return priorRetries < qualityRetryMax;
  return true;
}

export type JobOutcome =
  | { state: 'delivered'; notes?: string }
  | {
      state: 'skipped';
      reason: string;
      /**
       * The locale row is live (or its removal is final), so parents blocked
       * on this document may proceed. A skip that leaves the row absent — an
       * unchanged terminal failure, a superseded job — must not wake them.
       */
      published?: boolean;
    }
  | { state: 'deferred'; reason: string; delayMs: number }
  | {
      state: 'blocked';
      reason: string;
      dependencies: RelationDependency[];
      /** This row is live and may unblock parents despite its own optional drift. */
      published?: boolean;
    }
  | { state: 'failed'; reason: string };

export class TranslationDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private started = false;
  private readonly instanceId = randomUUID();
  private nextCleanupAt = 0;
  private nextDependencyReconcileAt = 0;
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
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
    logTranslation(this.strapi, 'info', 'translation.dispatcher_started', {
      provider: this.provider.name,
      model: this.config.model,
      instanceId: this.instanceId,
      pid: process.pid,
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
    this.timer = runInBackground(() => setTimeout(() => {
      this.timer = null;
      this.running = runInBackground(() => this.runCycle()).finally(() => {
        this.running = null;
        this.schedule(this.outboxConfig.pollMs);
      });
    }, delayMs));
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    try {
      if (this.stopped || (await enabledContentLocales(this.strapi)).length === 0) return;
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
      if (now >= this.nextDependencyReconcileAt) {
        this.nextDependencyReconcileAt = now + DEPENDENCY_RECONCILE_INTERVAL_MS;
        const awakened = await this.store.reconcileReadyBlocked();
        if (awakened > 0) {
          logTranslation(this.strapi, 'info', 'translation.dependencies_reconciled', {
            awakened,
          });
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(2, this.outboxConfig.batchSize) }, (_, index) =>
          this.dispatchOne(index > 0),
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

  private async dispatchOne(incrementalOnly = false): Promise<boolean> {
    if (this.stopped) return false;
    const locales = await enabledContentLocales(this.strapi);
    if (locales.length === 0) return false;
    const job = await this.store.claim({ incrementalOnly, locales: locales.map((locale) => locale.code) });
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
      if (!(await enabledContentLocales(this.strapi)).some((locale) => locale.code === job.targetLocale)) {
        throw new TranslationError('TRANSLATION_UNAVAILABLE', { detail: 'target language is disabled' });
      }
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
      // Older deployments retried quality failures without a ceiling. Stop
      // those already-over-limit rows immediately after upgrade, before they
      // can buy another identical writer/editor attempt.
      if (
        job.attemptCount > this.outboxConfig.qualityRetryMax &&
        job.lastError?.startsWith('TRANSLATION_QUALITY_GATE_FAILED')
      ) {
        outcome = {
          state: 'failed',
          reason:
            `quality retry limit reached after ${job.attemptCount} retries: ` +
            job.lastError,
        };
      } else {
        const result = await this.processJob(job, assertLease);
        outcome = result.outcome;
        usage = result.usage;
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const retryable = shouldRetryTranslationFailure(
        error,
        job.attemptCount,
        this.outboxConfig.qualityRetryMax,
      );
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
      const outcomeCode = outcome.state === 'delivered'
        ? 'delivered'
        : outcome.reason.startsWith('unchanged terminal failure')
          ? 'unchanged-terminal-failure'
          : outcome.reason.includes('already current')
            ? 'current'
            : outcome.reason.includes('source') && outcome.reason.includes('gone')
              ? 'source-gone'
              : 'skipped';
      const marked = await this.store.markDelivered(job, outcomeCode);
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
          // Parent wakeups are committed by the localized content write,
          // keyed on actual row availability rather than this job outcome.
          awakenedDependents: 0,
        });
      }
      return true;
    }
    if (outcome.state === 'blocked') {
      const marked = await this.store.markBlocked(
        job,
        outcome.dependencies,
        outcome.reason,
      );
      // A dependency delivered between this job's existence check and the
      // markBlocked above found no blocked row to wake. Re-check once now.
      const selfEnqueued = marked
        ? await this.store.enqueueSelfIfDependenciesArrived(job, outcome.dependencies)
        : false;
      logTranslation(this.strapi, 'warn', 'translation.job_blocked', {
        jobId: job.id,
        eventKey: job.eventKey,
        error: outcome.reason,
        blockedOn: outcome.dependencies,
        awakenedDependents: 0,
        selfEnqueued,
      });
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

    const previousNightlyJob =
      !job.force && job.reason === TRANSLATION_NIGHTLY_CONSISTENCY_REASON
        ? await this.store.previousJob(job)
        : null;

    // The UI-text dictionary has no document: its own tables are its memory
    // and it persists per key group. Everything below is per-entry work.
    if (job.uid === UI_DICTIONARY_UID) {
      if (previousNightlyJob?.status === 'failed' && !previousNightlyJob.sourceHash) {
        return {
          outcome: {
            state: 'skipped',
            reason: 'unchanged terminal failure; awaiting catalogue change or manual retry',
          },
          usage: noUsage,
        };
      }
      return processUiDictionaryJob({
        strapi: this.strapi,
        provider: this.provider,
        config: this.config,
        store: this.store,
        job,
        locale,
        assertLease,
        previousFailure: previousNightlyJob,
        recordSourceHash: (sourceHash) => this.store.recordSourceHash(job, sourceHash),
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
          published: true,
        },
        usage: noUsage,
      };
    }

    // Dead offers have no public route and must not buy a translation merely
    // because the catalogue backfill walks historical English rows. Keep any
    // existing locale row/memory intact for audit and possible reactivation.
    if (translationSourceIneligible(job.uid, source)) {
      return {
        outcome: { state: 'skipped', reason: 'expired source offer is not translation-eligible' },
        usage: noUsage,
      };
    }

    if (previousNightlyJob?.status === 'failed' && !previousNightlyJob.sourceHash) {
      const sourceUpdatedAt = new Date(source.updatedAt ?? source.updated_at ?? 0);
      if (
        Number.isFinite(sourceUpdatedAt.getTime()) &&
        sourceUpdatedAt <= previousNightlyJob.createdAt
      ) {
        return {
          outcome: {
            state: 'skipped',
            reason: 'unchanged terminal failure; awaiting English edit or manual retry',
          },
          usage: noUsage,
        };
      }
    }

    const leaves = collectTranslatableLeaves(this.strapi, job.uid, source);
    const hash = sourceContentHash(
      leaves,
      translationPromptFingerprint(this.strapi, locale),
    );
    await this.store.recordSourceHash?.(job, hash);
    if (previousNightlyJob?.status === 'failed') {
      const sourceUpdatedAt = new Date(source.updatedAt ?? source.updated_at ?? 0);
      const hashUnchanged = previousNightlyJob.sourceHash === hash;
      const legacyTimestampUnchanged =
        !previousNightlyJob.sourceHash &&
        Number.isFinite(sourceUpdatedAt.getTime()) &&
        sourceUpdatedAt <= previousNightlyJob.createdAt;
      if (hashUnchanged || legacyTimestampUnchanged) {
        return {
          outcome: {
            state: 'skipped',
            reason: 'unchanged terminal failure; awaiting English edit or manual retry',
          },
          usage: noUsage,
        };
      }
    }
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
    const leafSourceHashes = fieldFingerprints(leaves, translationPromptFingerprint(this.strapi, locale));
    const fields = selectTranslationFields(leaves, leafSourceHashes, state?.leafSourceHashes, memory, job.force);
    const textCurrent =
      !job.force && state?.sourceHash === hash && memoryComplete;

    if (textCurrent && !state?.leafSourceHashes) {
      await this.store.seedFieldFingerprints?.(job.uid, job.documentId, job.targetLocale, hash, leafSourceHashes);
    }

    // Required localized relations are publication dependencies, not a text
    // failure. Resolve them before the provider so a child that has not been
    // translated yet costs no tokens and leaves the existing locale row live.
    const sourceRelations = await resolveRelationDependencies(
      this.strapi,
      job.uid,
      source,
      job.targetLocale,
    );
    if (sourceRelations.required.length > 0) {
      return {
        outcome: {
          state: 'blocked',
          reason:
            `${sourceRelations.required.length} required relation target(s) ` +
            `missing in ${job.targetLocale}`,
          dependencies: sourceRelations.required,
        },
        usage: noUsage,
      };
    }

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
        fields.changed,
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
      translations = new Map([...fields.reused, ...result.translations]);
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
          published: true,
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
    // Durable paid output is committed after the final source-hash check but
    // before any publication dependency or write check. If a relation
    // disappears during the provider calls, or validation/persistence later
    // rejects the locale write, the repair job reuses these exact strings
    // without another call.
    if (!textCurrent) {
      await this.store.upsertState(job.uid, job.documentId, job.targetLocale, {
        sourceHash: hash,
        needsReview,
        reviewNotes: reviewNotes.length
          ? reviewNotes.join('\n').slice(0, 4_000)
          : null,
        lastError: null,
        translations: Object.fromEntries(translations),
        leafSourceHashes,
        publishedPlanHash: null,
      });
    }

    const latestRelations = await resolveRelationDependencies(
      this.strapi,
      job.uid,
      latestSource,
      job.targetLocale,
    );
    if (latestRelations.required.length > 0) {
      return {
        outcome: {
          state: 'blocked',
          reason:
            `${latestRelations.required.length} required relation target(s) ` +
            `missing in ${job.targetLocale}`,
          dependencies: latestRelations.required,
        },
        usage,
      };
    }

    // 5. A hash-current row may still need a write when relations/component
    // structure drifted, or when migrate:fresh removed the locale row while
    // translation memory survived. Inspect the exact write plan before using
    // the documents API: a true no-op must not emit another ISR invalidation.
    if (textCurrent) {
      const inspection = await inspectLocaleVersion(
        this.strapi,
        job.uid,
        job.documentId,
        job.targetLocale,
        latestSource,
        translations,
      );
      if (inspection.current) {
        await this.store.recordPublishedPlanHash?.(
          job.uid,
          job.documentId,
          job.targetLocale,
          inspection.planHash,
        );
        if (latestRelations.optional.length > 0) {
          return {
            outcome: {
              state: 'blocked',
              reason:
                `${latestRelations.optional.length} optional relation target(s) ` +
                `awaiting repair in ${job.targetLocale}`,
              dependencies: latestRelations.optional,
              published: true,
            },
            usage,
          };
        }
        return {
          outcome: {
            state: 'skipped',
            reason: 'locale version already current',
            published: true,
          },
          usage,
        };
      }
    }

    // 6. Persist the locale version through the document pipeline.
    await assertLease();
    let writeResult: Awaited<ReturnType<typeof writeLocaleVersion>>;
    try {
      writeResult = await withLocalePublication(() => writeLocaleVersion(
        this.strapi,
        job.uid,
        job.documentId,
        job.targetLocale,
        latestSource,
        translations,
        async (trx: any) => {
          let lease = trx('translation_outbox').where({ id: job.id, status: 'processing', lock_token: job.lockToken });
          if (['pg', 'postgres', 'postgresql'].includes(trx.client.config.client)) lease = lease.forUpdate();
          const owned = await lease.first('id');
          if (!owned) throw new TranslationError('TRANSLATION_LEASE_LOST');
        },
      ));
    } catch (cause) {
      if (cause instanceof TranslationDependencyBlockedError) {
        return {
          outcome: {
            state: 'blocked',
            reason:
              `${cause.dependencies.length} required relation target(s) ` +
              `missing in ${job.targetLocale}`,
            dependencies: cause.dependencies,
          },
          usage,
        };
      }
      if (!isPermanentTranslationWriteError(cause)) throw cause;
      await this.store.upsertState(job.uid, job.documentId, job.targetLocale, {
        sourceHash: hash,
        needsReview,
        reviewNotes: reviewNotes.length
          ? reviewNotes.join('\n').slice(0, 4_000)
          : null,
        lastError: cause instanceof Error ? cause.message : String(cause),
        translations: Object.fromEntries(translations),
        leafSourceHashes,
        publishedPlanHash: null,
      });
      throw new TranslationError('TRANSLATION_WRITE_REJECTED', {
        cause,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    await assertLease();

    // The success write carries the field fingerprints too: it is the row the
    // next English edit reads to decide which fields actually changed.
    await this.store.upsertState(job.uid, job.documentId, job.targetLocale, {
      sourceHash: hash,
      needsReview,
      reviewNotes: reviewNotes.length
        ? reviewNotes.join('\n').slice(0, 4_000)
        : null,
      lastError: null,
      translations: Object.fromEntries(translations),
      leafSourceHashes,
      publishedPlanHash: writeResult.planHash,
    });

    // 7. Optional forward-curation joins may be repaired after the base entity
    // exists, but the job remains visibly blocked until that exact repair.
    if (writeResult.missingDependencies.length > 0) {
      return {
        outcome: {
          state: 'blocked',
          reason:
            `${writeResult.missingDependencies.length} optional relation ` +
            `target(s) awaiting repair in ${job.targetLocale}`,
          dependencies: writeResult.missingDependencies,
          published: true,
        },
        usage,
      };
    }
    return { outcome: { state: 'delivered' }, usage };
  }

}
