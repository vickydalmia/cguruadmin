import type { Core } from '@strapi/strapi';
import { executeRebuild, type RebuildJob } from './worker';

// In-memory, debounced rebuild queue. Scopes merge until REBUILD_DEBOUNCE_MS
// of quiet, then a single-flight worker builds + deploys. Deliberately not
// persisted: a restart loses pending scopes, and the nightly full build is
// the consistency net (see cguru-ui/docs/deployment-runbook.md §8.4).

export interface ScopeRequest {
  full?: boolean;
  homepage?: boolean;
  slugs?: string[];
}

interface PendingScope {
  full: boolean;
  homepage: boolean;
  slugs: Set<string>;
  reasons: string[];
}

const emptyScope = (): PendingScope => ({
  full: false,
  homepage: false,
  slugs: new Set(),
  reasons: [],
});

export function rebuildConfig() {
  return {
    enabled: process.env.REBUILD_ENABLED === 'true',
    frontendDir: process.env.FRONTEND_DIR?.trim() || '',
    siteBucket: process.env.SITE_BUCKET?.trim() || '',
    distributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID?.trim() || '',
    debounceMs: Number(process.env.REBUILD_DEBOUNCE_MS) || 60_000,
    // With a team editing continuously there may NEVER be a quiet gap, so the
    // debounce alone would postpone builds forever. This ceiling forces a
    // build at most this long after the batch's FIRST change.
    maxWaitMs: Number(process.env.REBUILD_MAX_WAIT_MS) || 300_000,
    fullThreshold: Number(process.env.REBUILD_FULL_THRESHOLD) || 150,
  };
}

let pending = emptyScope();
let timer: NodeJS.Timeout | null = null;
let building = false;
let batchStartedAt: number | null = null;

function describe(scope: PendingScope): string {
  if (scope.full) return 'FULL';
  const parts: string[] = [];
  if (scope.homepage) parts.push('homepage');
  if (scope.slugs.size) parts.push(`${scope.slugs.size} page(s): ${[...scope.slugs].slice(0, 8).join(', ')}${scope.slugs.size > 8 ? '…' : ''}`);
  return parts.join(' + ') || 'nothing';
}

export function enqueue(strapi: Core.Strapi, request: ScopeRequest, reason: string): void {
  const config = rebuildConfig();

  if (request.full) pending.full = true;
  if (request.homepage) pending.homepage = true;
  for (const slug of request.slugs ?? []) pending.slugs.add(slug);
  pending.reasons.push(reason);

  if (!pending.full && pending.slugs.size > config.fullThreshold) {
    pending.full = true;
    pending.reasons.push(`escalated to full (> ${config.fullThreshold} pages)`);
  }

  strapi.log.info(`[rebuild] enqueued: ${describe(pending)} (${reason})`);

  if (!config.enabled) {
    strapi.log.info('[rebuild] REBUILD_ENABLED is not true — scope logged, no build scheduled');
    return;
  }

  // Debounce restarts on every change, but never past the batch's hard
  // deadline (first-change time + maxWaitMs) — continuous editing cannot
  // starve deploys.
  if (batchStartedAt === null) batchStartedAt = Date.now();
  const deadlineIn = Math.max(0, batchStartedAt + config.maxWaitMs - Date.now());
  schedule(strapi, Math.min(config.debounceMs, deadlineIn));
}

function schedule(strapi: Core.Strapi, delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void run(strapi), delayMs);
  // Never keep the process alive just for a pending rebuild.
  timer.unref?.();
}

async function run(strapi: Core.Strapi): Promise<void> {
  if (building) return; // the finally-block reschedules if anything is pending

  const hasWork = pending.full || pending.homepage || pending.slugs.size > 0;
  if (!hasWork) return;

  batchStartedAt = null;
  const job: RebuildJob = {
    full: pending.full,
    homepage: pending.homepage,
    slugs: [...pending.slugs],
    reasons: pending.reasons,
  };
  pending = emptyScope();
  building = true;

  try {
    await executeRebuild(strapi, job);
  } catch (err: any) {
    // Failed builds never deploy; merge the scope back and retry after the
    // debounce window instead of hot-looping.
    strapi.log.error(`[rebuild] build/deploy failed: ${err?.message ?? err} — will retry`);
    enqueue(strapi, { full: job.full, homepage: job.homepage, slugs: job.slugs }, 'retry after failure');
  } finally {
    building = false;
    if (pending.full || pending.homepage || pending.slugs.size > 0) {
      schedule(strapi, rebuildConfig().debounceMs);
    }
  }
}

export function destroyRebuildQueue(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
