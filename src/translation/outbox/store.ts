// Translation OUTBOX STORE: table access for the job queue and the
// per-locale translation state. Clone of the ISR outbox store's claim/lease
// discipline (src/isr-outbox/store.ts), plus the cost ledger the daily
// budget stop reads.
import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import type { TranslationConfig } from '../config';
import { usdForTokens } from '../cost';
import { TranslationError } from '../errors';
import type {
  CompletionAttemptContext,
  CompletionAttemptHooks,
} from '../provider';
import type { ProviderCompletion } from '../provider/types';

export const TRANSLATION_OUTBOX_TABLE = 'translation_outbox';
export const TRANSLATION_STATE_TABLE = 'translation_state';
export const TRANSLATION_USAGE_TABLE = 'translation_usage';

type Transaction = any;

export type TranslationJobKind = 'translate' | 'relation-sync';

export type TranslationJob = {
  id: string;
  eventKey: string;
  uid: string;
  documentId: string;
  targetLocale: string;
  kind: TranslationJobKind;
  force: boolean;
  attemptCount: number;
  lastError: string | null;
  lockToken: string;
  reason: string;
};

export type TranslationJobInsert = {
  uid: string;
  documentId: string;
  targetLocale: string;
  kind: TranslationJobKind;
  force?: boolean;
  reason: string;
};

export function translationEventKey(input: {
  uid: string;
  documentId: string;
  targetLocale: string;
}): string {
  return `${input.uid}:${input.documentId}:${input.targetLocale}`;
}

/**
 * Coalescing insert: at most one PENDING job per document+locale (partial
 * unique index). A conflicting insert upgrades the pending row instead —
 * 'translate' wins over 'relation-sync', force is sticky — so a burst of
 * editor saves costs one job. MUST run on the write's own transaction when
 * called from the document middleware (see runContentTransaction's note).
 */
export async function insertTranslationJob(
  transaction: Transaction,
  input: TranslationJobInsert,
): Promise<void> {
  const eventKey = translationEventKey(input);
  // Serialize enqueue against a worker returning this same event key to the
  // pending state. Without this lock, a save that lands while an older job is
  // processing can create a newer pending row and make the older worker's
  // retry violate the partial unique index.
  await transaction.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [eventKey]);
  await transaction.raw(
    `INSERT INTO ${TRANSLATION_OUTBOX_TABLE} ` +
      `(event_key, uid, document_id, target_locale, kind, force, status, ` +
      `attempt_count, next_attempt_at, reason, created_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?) ` +
      `ON CONFLICT (event_key) WHERE status = 'pending' DO UPDATE SET ` +
      `kind = CASE WHEN excluded.kind = 'translate' ` +
      `OR ${TRANSLATION_OUTBOX_TABLE}.kind = 'translate' ` +
      `THEN 'translate' ELSE 'relation-sync' END, ` +
      `force = ${TRANSLATION_OUTBOX_TABLE}.force OR excluded.force, ` +
      `reason = excluded.reason`,
    [
      eventKey,
      input.uid,
      input.documentId,
      input.targetLocale,
      input.kind,
      input.force === true,
      new Date(),
      input.reason.slice(0, 255),
      new Date(),
    ],
  );
}

/**
 * Multi-row coalescing insert for the backfill: same upsert semantics as
 * insertTranslationJob, one statement per chunk of documents.
 */
export async function insertTranslationJobsBulk(
  transaction: Transaction,
  inputs: readonly TranslationJobInsert[],
): Promise<void> {
  const CHUNK = 500;
  for (let start = 0; start < inputs.length; start += CHUNK) {
    const chunk = inputs.slice(start, start + CHUNK);
    const eventKeys = [...new Set(chunk.map(translationEventKey))].sort();
    await transaction.raw(
      `SELECT pg_advisory_xact_lock(hashtext(event_key)) ` +
        `FROM (SELECT unnest(?::text[]) AS event_key ORDER BY 1) AS locks`,
      [eventKeys],
    );
    const now = new Date();
    const values = chunk
      .map(() => `(?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .join(', ');
    const bindings = chunk.flatMap((input) => [
      translationEventKey(input),
      input.uid,
      input.documentId,
      input.targetLocale,
      input.kind,
      input.force === true,
      now,
      input.reason.slice(0, 255),
      now,
    ]);
    await transaction.raw(
      `INSERT INTO ${TRANSLATION_OUTBOX_TABLE} ` +
        `(event_key, uid, document_id, target_locale, kind, force, status, ` +
        `attempt_count, next_attempt_at, reason, created_at) ` +
        `VALUES ${values} ` +
        `ON CONFLICT (event_key) WHERE status = 'pending' DO UPDATE SET ` +
        `kind = CASE WHEN excluded.kind = 'translate' ` +
        `OR ${TRANSLATION_OUTBOX_TABLE}.kind = 'translate' ` +
        `THEN 'translate' ELSE 'relation-sync' END, ` +
        `force = ${TRANSLATION_OUTBOX_TABLE}.force OR excluded.force, ` +
        `reason = excluded.reason`,
      bindings,
    );
  }
}

function toJob(row: any, lockToken: string): TranslationJob {
  return {
    id: String(row.id),
    eventKey: String(row.event_key),
    uid: String(row.uid),
    documentId: String(row.document_id),
    targetLocale: String(row.target_locale),
    kind: row.kind === 'relation-sync' ? 'relation-sync' : 'translate',
    force: row.force === true || row.force === 1,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error ?? null,
    lockToken,
    reason: String(row.reason ?? ''),
  };
}

export type TranslationStateRow = {
  sourceHash: string;
  translatedAt: Date | null;
  needsReview: boolean;
  reviewNotes: string | null;
  lastError: string | null;
  /**
   * TRANSLATION MEMORY: the delivered translation per leaf path. The
   * durable copy of the translated text — the locale ROWS live in content
   * tables that migrate:fresh truncates, while this table survives, so a
   * hash-matching re-import rebuilds every locale version from here with
   * zero LLM calls. Null on rows written before the column existed, which
   * the dispatcher treats as "must re-translate".
   */
  translations: Record<string, string> | null;
};

/**
 * jsonb comes back as an object from pg and as its text form from sqlite;
 * a malformed value reads as "no memory" (→ re-translate), never a throw.
 */
function parseStoredTranslations(
  value: unknown,
): Record<string, string> | null {
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
}

export type TranslationOutboxSummary = {
  counts: Record<string, number>;
  oldestUndeliveredAt: string | null;
  expiredProcessing: number;
  deliveredToday: number;
  costTodayUsd: number;
  estimatedCostTodayUsd: number;
};

export class TranslationOutboxStore {
  constructor(
    private readonly strapi: Core.Strapi,
    private readonly leaseMs: number,
    private readonly maxBackoffMs: number,
  ) {}

  async claim(): Promise<TranslationJob | null> {
    return this.strapi.db.transaction(async ({ trx }: any) => {
      const now = new Date();
      const expiredLease = new Date(now.getTime() - this.leaseMs);
      const row = await trx(TRANSLATION_OUTBOX_TABLE)
        .where((query: any) => {
          query
            .where((pending: any) => {
              pending
                .where('status', 'pending')
                .where('next_attempt_at', '<=', now);
            })
            .orWhere((processing: any) => {
              processing
                .where('status', 'processing')
                .where('locked_at', '<=', expiredLease);
            });
        })
        .orderBy('id', 'asc')
        .forUpdate()
        .skipLocked()
        .first();
      if (!row) return null;
      const lockToken = randomUUID();
      await trx(TRANSLATION_OUTBOX_TABLE)
        .where({ id: row.id })
        .update({ status: 'processing', locked_at: now, lock_token: lockToken });
      return toJob(row, lockToken);
    });
  }

  private ownedUpdate(job: TranslationJob) {
    return this.strapi.db
      .connection(TRANSLATION_OUTBOX_TABLE)
      .where({
        id: job.id,
        status: 'processing',
        lock_token: job.lockToken,
      });
  }

  /** Keep a long-running provider job from being reclaimed by another worker. */
  async refreshLease(job: TranslationJob): Promise<boolean> {
    const updated = await this.ownedUpdate(job).update({ locked_at: new Date() });
    return Number(updated) === 1;
  }

  async markDelivered(job: TranslationJob): Promise<boolean> {
    const now = new Date();
    const updated = await this.ownedUpdate(job).update({
      status: 'delivered',
      delivered_at: now,
      locked_at: null,
      lock_token: null,
      last_error: null,
    });
    return Number(updated) === 1;
  }

  /** Terminal failure: visible in status/panel, never retried. */
  async markFailed(job: TranslationJob, error: string): Promise<boolean> {
    const updated = await this.ownedUpdate(job).update({
      status: 'failed',
      locked_at: null,
      lock_token: null,
      last_error: error.slice(0, 4_000),
    });
    return Number(updated) === 1;
  }

  async scheduleRetry(
    job: TranslationJob,
    error: string,
    delayMsOverride?: number,
  ): Promise<{
    owned: boolean;
    attemptCount: number;
    delayMs: number;
    superseded: boolean;
  }> {
    const attemptCount = job.attemptCount + 1;
    const delayMs =
      delayMsOverride ??
      Math.min(this.maxBackoffMs, 2_000 * 2 ** Math.min(attemptCount - 1, 12));
    return this.strapi.db.transaction(async ({ trx }: any) => {
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [job.eventKey]);
      const newerPending = await trx(TRANSLATION_OUTBOX_TABLE)
        .where({ event_key: job.eventKey, status: 'pending' })
        .whereNot({ id: job.id })
        .orderBy('id', 'desc')
        .first();
      if (newerPending) {
        const updated = await trx(TRANSLATION_OUTBOX_TABLE)
          .where({
            id: job.id,
            status: 'processing',
            lock_token: job.lockToken,
          })
          .update({
            status: 'delivered',
            delivered_at: new Date(),
            locked_at: null,
            lock_token: null,
            last_error: 'superseded by a newer pending translation job',
          });
        return {
          owned: Number(updated) === 1,
          attemptCount,
          delayMs: 0,
          superseded: true,
        };
      }
      const updated = await trx(TRANSLATION_OUTBOX_TABLE)
        .where({
          id: job.id,
          status: 'processing',
          lock_token: job.lockToken,
        })
        .update({
          status: 'pending',
          attempt_count: attemptCount,
          next_attempt_at: new Date(Date.now() + delayMs),
          locked_at: null,
          lock_token: null,
          last_error: error.slice(0, 4_000),
        });
      return {
        owned: Number(updated) === 1,
        attemptCount,
        delayMs,
        superseded: false,
      };
    });
  }

  async deleteDeliveredBefore(cutoff: Date): Promise<number> {
    const deleted = await this.strapi.db
      .connection(TRANSLATION_OUTBOX_TABLE)
      .whereIn('status', ['delivered', 'failed'])
      .where('created_at', '<', cutoff)
      .delete();
    await this.strapi.db
      .connection(TRANSLATION_USAGE_TABLE)
      .where('created_at', '<', cutoff)
      .delete();
    return Number(deleted);
  }

  /** USD reserved/charged since UTC midnight — the daily budget ledger. */
  async costSinceUtcMidnight(): Promise<number> {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const row: any = await this.strapi.db
      .connection(TRANSLATION_USAGE_TABLE)
      .where('created_at', '>=', midnight)
      .sum({ total: 'cost_usd' })
      .first();
    return Number(row?.total ?? 0);
  }

  private estimatedAttemptCost(
    config: TranslationConfig,
    context: CompletionAttemptContext,
  ): number {
    // UTF-8 bytes are a deliberately conservative tokenizer-independent
    // ceiling, including for Arabic where the usual English chars/4 heuristic
    // can badly under-reserve. A hard budget must fail closed.
    const inputTokens = Buffer.byteLength(
      `${context.system}${context.user}`,
      'utf8',
    );
    return (
      Math.ceil(
        usdForTokens(config, inputTokens, context.maxOutputTokens) * 1_000_000,
      ) / 1_000_000
    );
  }

  /**
   * Serialize the budget check and reservation across every app process.
   * The reservation uses the call's full output ceiling, then settles to
   * provider-reported usage. Unknown failed calls remain conservatively
   * charged at the reservation so retries cannot silently exceed the cap.
   */
  async reserveProviderAttempt(
    job: TranslationJob,
    config: TranslationConfig,
    provider: string,
    stage: string,
    context: CompletionAttemptContext,
  ): Promise<string> {
    const reservationId = randomUUID();
    const estimatedCost = this.estimatedAttemptCost(config, context);
    await this.strapi.db.transaction(async ({ trx }: any) => {
      if (config.dailyBudgetUsd > 0) {
        await trx.raw(
          `SELECT pg_advisory_xact_lock(hashtext(?))`,
          ['translation-daily-budget'],
        );
        const midnight = new Date();
        midnight.setUTCHours(0, 0, 0, 0);
        const row = await trx(TRANSLATION_USAGE_TABLE)
          .where('created_at', '>=', midnight)
          .sum({ total: 'cost_usd' })
          .first();
        const committed = Number(row?.total ?? 0);
        if (committed + estimatedCost > config.dailyBudgetUsd) {
          throw new TranslationError('TRANSLATION_BUDGET_EXCEEDED', {
            detail:
              `daily budget ${config.dailyBudgetUsd} USD cannot reserve ` +
              `${estimatedCost.toFixed(6)} USD (${committed.toFixed(6)} reserved/charged)`,
          });
        }
      }
      await trx(TRANSLATION_USAGE_TABLE).insert({
        reservation_id: reservationId,
        job_id: job.id,
        event_key: job.eventKey,
        target_locale: job.targetLocale,
        stage,
        provider,
        model: config.model,
        attempt: context.attempt,
        status: 'reserved',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: estimatedCost,
        created_at: new Date(),
      });
    });
    return reservationId;
  }

  async settleProviderAttempt(
    reservationId: string,
    job: TranslationJob,
    config: TranslationConfig,
    completion?: ProviderCompletion,
    error?: TranslationError,
  ): Promise<void> {
    await this.strapi.db.transaction(async ({ trx }: any) => {
      const usage: any = await trx(TRANSLATION_USAGE_TABLE)
        .where({ reservation_id: reservationId, status: 'reserved' })
        .first();
      if (!usage) return;
      const cost = completion
        ? Math.ceil(
            usdForTokens(
              config,
              completion.inputTokens,
              completion.outputTokens,
            ) * 1_000_000,
          ) / 1_000_000
        : Number(usage.cost_usd ?? 0);
      await trx(TRANSLATION_USAGE_TABLE)
        .where({ reservation_id: reservationId, status: 'reserved' })
        .update({
          status: completion ? 'charged' : 'uncertain',
          model: completion?.model ?? config.model,
          input_tokens: completion?.inputTokens ?? 0,
          output_tokens: completion?.outputTokens ?? 0,
          cost_usd: cost,
          error: error?.message?.slice(0, 1_000) ?? null,
          settled_at: new Date(),
        });
      if (completion) {
        await trx(TRANSLATION_OUTBOX_TABLE)
          .where({
            id: job.id,
            status: 'processing',
            lock_token: job.lockToken,
          })
          .increment('tokens_in', completion.inputTokens)
          .increment('tokens_out', completion.outputTokens)
          .increment('cost_usd', cost);
      }
    });
  }

  providerAttemptHooks(
    job: TranslationJob,
    config: TranslationConfig,
    provider: string,
    stage: string,
  ): CompletionAttemptHooks {
    return {
      beforeAttempt: (context) =>
        this.reserveProviderAttempt(job, config, provider, stage, context),
      afterAttempt: async ({ reservation, completion, error }) => {
        if (typeof reservation !== 'string') return;
        try {
          await this.settleProviderAttempt(
            reservation,
            job,
            config,
            completion,
            error,
          );
        } catch (cause) {
          // The reservation already counts its conservative cost. Do not
          // discard a paid successful completion and ask the provider for the
          // same translation again only because settlement briefly failed.
          if (completion) {
            this.strapi.log.error(
              `[translation] usage settlement failed for reservation ${reservation}: ` +
                `${cause instanceof Error ? cause.message : String(cause)}`,
            );
            return;
          }
          throw cause;
        }
      },
    };
  }

  async statusSummary(): Promise<TranslationOutboxSummary> {
    const connection = this.strapi.db.connection;
    const expiredLease = new Date(Date.now() - this.leaseMs);
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const [countRows, oldestRow, expiredRow, todayRow, usageRow] = await Promise.all([
      connection(TRANSLATION_OUTBOX_TABLE)
        .select('status')
        .count({ count: '*' })
        .groupBy('status'),
      connection(TRANSLATION_OUTBOX_TABLE)
        .whereIn('status', ['pending', 'processing'])
        .min({ oldest: 'created_at' })
        .first(),
      connection(TRANSLATION_OUTBOX_TABLE)
        .where({ status: 'processing' })
        .where('locked_at', '<=', expiredLease)
        .count({ count: '*' })
        .first(),
      connection(TRANSLATION_OUTBOX_TABLE)
        .where('delivered_at', '>=', midnight)
        .count({ count: '*' })
        .sum({ cost: 'cost_usd' })
        .first(),
      connection(TRANSLATION_USAGE_TABLE)
        .where('created_at', '>=', midnight)
        .select(
          connection.raw('COALESCE(SUM(cost_usd), 0) AS cost'),
          connection.raw(
            `COALESCE(SUM(CASE WHEN status = 'uncertain' THEN cost_usd ELSE 0 END), 0) AS estimated_cost`,
          ),
        )
        .first(),
    ]);
    const counts = Object.fromEntries(
      (countRows as any[]).map((row) => [
        String(row.status),
        Number(row.count ?? 0),
      ]),
    );
    const oldest = (oldestRow as any)?.oldest;
    return {
      counts,
      oldestUndeliveredAt: oldest ? new Date(oldest).toISOString() : null,
      expiredProcessing: Number((expiredRow as any)?.count ?? 0),
      deliveredToday: Number((todayRow as any)?.count ?? 0),
      costTodayUsd: Number((usageRow as any)?.cost ?? 0),
      estimatedCostTodayUsd: Number((usageRow as any)?.estimated_cost ?? 0),
    };
  }

  async readState(
    uid: string,
    documentId: string,
    locale: string,
  ): Promise<TranslationStateRow | null> {
    const row: any = await this.strapi.db
      .connection(TRANSLATION_STATE_TABLE)
      .where({ uid, document_id: documentId, locale })
      .first();
    if (!row) return null;
    return {
      sourceHash: String(row.source_hash),
      translatedAt: row.translated_at ? new Date(row.translated_at) : null,
      needsReview: row.needs_review === true || row.needs_review === 1,
      reviewNotes: row.review_notes ?? null,
      lastError: row.last_error ?? null,
      translations: parseStoredTranslations(row.translations),
    };
  }

  async upsertState(
    uid: string,
    documentId: string,
    locale: string,
    state: {
      sourceHash: string;
      needsReview: boolean;
      reviewNotes: string | null;
      lastError: string | null;
      /** The delivered leaf translations — the durable translation memory. */
      translations: Record<string, string> | null;
    },
  ): Promise<void> {
    const values = {
      source_hash: state.sourceHash,
      translated_at: new Date(),
      needs_review: state.needsReview,
      review_notes: state.reviewNotes,
      last_error: state.lastError,
      translations:
        state.translations === null ? null : JSON.stringify(state.translations),
    };
    await this.strapi.db
      .connection(TRANSLATION_STATE_TABLE)
      .insert({ uid, document_id: documentId, locale, ...values })
      .onConflict(['uid', 'document_id', 'locale'])
      .merge(values);
  }

  async deleteState(
    uid: string,
    documentId: string,
    locale?: string,
  ): Promise<void> {
    const query = this.strapi.db
      .connection(TRANSLATION_STATE_TABLE)
      .where({ uid, document_id: documentId });
    if (locale) query.andWhere({ locale });
    await query.delete();
  }

  /** Newest job for one document; terminal success supersedes old failures. */
  async activeJob(
    uid: string,
    documentId: string,
    locale: string,
  ): Promise<{ status: string; attemptCount: number; lastError: string | null } | null> {
    const row: any = await this.strapi.db
      .connection(TRANSLATION_OUTBOX_TABLE)
      .where({ uid, document_id: documentId, target_locale: locale })
      .orderBy('id', 'desc')
      .first();
    if (!row) return null;
    return {
      status: String(row.status),
      attemptCount: Number(row.attempt_count),
      lastError: row.last_error ?? null,
    };
  }
}
