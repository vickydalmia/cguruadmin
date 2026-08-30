import type { Core } from '@strapi/strapi';

import { isIdentityUid } from '../identity-uids';
import { JOB_UID } from '../job-slug-validation';
import { isHumanWrite } from '../write-origin';
import {
  acquireWriteSerializationLock,
  type WriteLockDomain,
  type WriteLockRelease,
} from '../write-serialization';

import { ProblemCollector } from './problems';
import {
  COLLECTED_STEPS,
  LOCKED_STEPS,
  MUTATOR_STEPS,
  SIDE_EFFECT_STEPS,
  WRITE_ACTIONS,
  stepApplies,
  type StepContext,
  type ValidationStep,
} from './steps';

/**
 * Runs the write-validation pipeline for one document-service write.
 *
 * THE POINT OF THIS FILE. The validators were always capable of reporting every
 * problem they found; the middleware just never let them. It awaited twelve of
 * them in sequence, so the first to throw aborted the request and the other
 * eleven never ran — an entry with a bad slug and a blank required field
 * reported the slug on the first save and the blank field on the second. Group
 * B below runs all of them and reports the union, so one Save shows everything.
 *
 * What is deliberately NOT merged, and why:
 *  - Group C (identity / campaign-template owner / redirect) needs a Postgres advisory lock held across
 *    validate AND commit. Taking that lock for a save group B already condemned
 *    would serialize every other editor behind work that is going to be thrown
 *    away.
 *  - The deal-image step calls a paid background-removal provider. Same
 *    reasoning, with money attached.
 * Both are rare enough that the extra round trip costs an editor far less than
 * the lock contention or the credit would.
 *
 * Returns the lock release handle, or null when no lock was taken. THE CALLER
 * MUST release it in a `finally` after the write commits — the lock's whole
 * purpose is to span validate + commit, so this function cannot release it
 * itself. If anything after acquisition throws, the lock is released here
 * before the error propagates, so a rejected save never leaks it.
 */
export async function runWriteValidation(
  strapi: Core.Strapi,
  context: {
    uid: string;
    action: string;
    params?: { data?: any; documentId?: string; locale?: string };
  },
): Promise<WriteLockRelease | null> {
  const { uid, action } = context;
  if (!WRITE_ACTIONS.includes(action as (typeof WRITE_ACTIONS)[number])) return null;

  const ctx: StepContext = {
    strapi,
    uid,
    action,
    data: context.params?.data,
    documentId: context.params?.documentId,
    // "Clean as you touch": a human editing in the admin must save a FULLY
    // valid record — every rule enforced on the whole record, including dirty
    // untouched fields on WordPress-migrated rows. The status cron (partial
    // {contentStatus} writes over possibly-dirty rows) has no HTTP request
    // context, so it stays grandfathered/touched-only and never throws on
    // migrated data. Computed once; passed to each validator.
    strict: isHumanWrite(strapi),
    // Which locale version of the document this write targets (undefined =
    // default). Validators that resolve partial payloads against the STORED
    // row must read that locale's row, not whichever one db.query finds first.
    locale:
      typeof context.params?.locale === 'string'
        ? context.params.locale
        : undefined,
  };

  // --- Group A: mutators. Never throw; every validator below reads what they
  // leave behind, so they must run even on a write that is about to fail.
  for (const step of applicable(MUTATOR_STEPS, ctx)) {
    await step.run(ctx);
  }

  // --- Group B: every pure validator runs, and their problems are merged into
  // one error. This is the group that produces nearly everything an editor
  // sees, and the reason this file exists.
  const collector = new ProblemCollector();
  for (const step of applicable(COLLECTED_STEPS, ctx)) {
    await collector.run(() => step.run(ctx));
  }
  collector.throwIfAny();

  // --- Group D: side effects, fail-fast, now that the record is otherwise
  // known-good. Before the lock, to keep the lock window as short as possible.
  for (const step of applicable(SIDE_EFFECT_STEPS, ctx)) {
    await step.run(ctx);
  }

  // --- Group C: cross-row invariants, under the advisory lock.
  const domain = lockDomainFor(uid);
  if (!domain) {
    // No lock needed, but the two validators still run for every uid — each
    // no-ops internally on a type it does not own. Unchanged from the original
    // middleware, which also called both unconditionally.
    await collectLockedSteps(ctx);
    return null;
  }

  const release = await acquireWriteSerializationLock(strapi, domain);
  try {
    await collectLockedSteps(ctx);
  } catch (error) {
    // Only on the failure path. On success the caller owns the release, because
    // the lock must still be held while the write commits.
    if (release) await release();
    throw error;
  }
  return release;
}

function applicable(
  steps: readonly ValidationStep[],
  ctx: StepContext,
): ValidationStep[] {
  return steps.filter((step) => stepApplies(step, ctx.uid, ctx.action));
}

/** Cross-row invariant problems are merged with each other, then thrown once. */
async function collectLockedSteps(ctx: StepContext): Promise<void> {
  const collector = new ProblemCollector();
  for (const step of applicable(LOCKED_STEPS, ctx)) {
    await collector.run(() => step.run(ctx));
  }
  collector.throwIfAny();
}

/**
 * Which advisory-lock domain this uid's cross-row invariants belong to, or null
 * when it has none. Entity identity and template ownership share one domain;
 * redirect and job each keep their existing lock. Every guard is a
 * read-then-write invariant that must serialize validation through commit.
 */
function lockDomainFor(uid: string): WriteLockDomain | null {
  if (isIdentityUid(uid)) return 'identity';
  if (uid === 'api::redirect.redirect') return 'redirect';
  if (uid === JOB_UID) return 'job';
  return null;
}
