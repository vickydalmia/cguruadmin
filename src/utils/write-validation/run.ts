import type { Core } from '@strapi/strapi';

import {
  isAffiliateEntityUid,
  touchesAffiliateFields,
  touchesEntityOfferRelations,
} from '../affiliate-brand-validation';
import { isOfferStoreUid } from '../content-manager-offer-store-validation';
import { isIdentityUid } from '../identity-validation';
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
 *  - Group C (identity / redirect) needs a Postgres advisory lock held across
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
  context: { uid: string; action: string; params?: { data?: any; documentId?: string } },
): Promise<WriteLockRelease | null> {
  const { uid, action } = context;
  if (!WRITE_ACTIONS.includes(action as (typeof WRITE_ACTIONS)[number])) {
    // Store/Brand deletion clears checkoutMerchant references in its content
    // transaction. Hold the same fail-closed affiliate lock as offer writes,
    // otherwise an offer can validate the target, lose a delete race, and
    // commit a dangling string reference after the delete has finished.
    if (action !== 'delete' || !isAffiliateEntityUid(uid)) return null;
    return acquireLocks(strapi, lockDomainsFor(uid, undefined, action));
  }

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

  // --- Group C: cross-row invariants, under the advisory lock(s).
  const domains = lockDomainsFor(uid, ctx.data, action);
  if (domains.length === 0) {
    // No lock needed, but the locked validators still run for every uid — each
    // no-ops internally on a type it does not own. Unchanged from the original
    // middleware, which also called them unconditionally.
    await collectLockedSteps(ctx);
    return null;
  }

  const release = await acquireLocks(strapi, domains);
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

/**
 * Domains whose lock guards a hard data invariant rather than a uniqueness
 * nicety: unavailability rejects the save (retryable error) instead of
 * proceeding unserialized. See acquireWriteSerializationLock's contract.
 */
const FAIL_CLOSED_DOMAINS: ReadonlySet<WriteLockDomain> = new Set(['affiliate']);

/**
 * All domains are taken on ONE dedicated lock connection inside
 * acquireWriteSerializationLock, all-or-nothing (a failed statement poisons
 * the lock transaction, so partial acquisition cannot exist). A save whose
 * domain set contains a fail-closed domain therefore rejects on ANY
 * acquisition failure; pure fail-open sets proceed unserialized as before.
 */
async function acquireLocks(
  strapi: Core.Strapi,
  domains: readonly WriteLockDomain[],
): Promise<WriteLockRelease | null> {
  return acquireWriteSerializationLock(strapi, domains, {
    onUnavailable: domains.some((domain) => FAIL_CLOSED_DOMAINS.has(domain))
      ? 'closed'
      : 'open',
  });
}

function applicable(
  steps: readonly ValidationStep[],
  ctx: StepContext,
): ValidationStep[] {
  return steps.filter((step) => stepApplies(step, ctx.uid, ctx.action));
}

/** Identity and redirect problems are merged with each other, then thrown once. */
async function collectLockedSteps(ctx: StepContext): Promise<void> {
  const collector = new ProblemCollector();
  for (const step of applicable(LOCKED_STEPS, ctx)) {
    await collector.run(() => step.run(ctx));
  }
  collector.throwIfAny();
}

/**
 * Which advisory-lock domains this write's cross-row invariants belong to, in
 * the fixed acquisition order. Identity and redirect are the middleware's
 * original selection; job was added with the slug uid→string conversion, whose
 * uniqueness guard is read-then-write like the other two.
 *
 * 'affiliate' serializes the write paths that can otherwise race the
 * affiliate-brand exclusivity invariant past each other:
 *  - an offer write whose payload touches brands/stores/checkoutMerchant
 *    (validateOfferAffiliateBrands judges it in the LOCKED pass);
 *  - an offer CLONE regardless of payload — Strapi copies the source's
 *    relations even when the submitted data omits every relation field, so
 *    the validator judges inherited state the payload cannot reveal;
 *  - ANY brand save (it may set isAffiliate and run detachAffiliateBrand
 *    inside its transaction; brand saves are rare, so taking the lock without
 *    pre-reading the payload costs nothing);
 *  - a store save whose payload touches its coupons/deals inverses
 *    (validateEntityOfferAffiliateConnections judges the connected offers).
 * With every side holding the lock across validate + commit: offer-first, the
 * flip's cascade sees the committed connect and detaches; flip-first, the
 * offer validates against the committed flag and is rejected. Non-Postgres
 * proceeds unserialized — the pre-existing accepted policy.
 */
export function lockDomainsFor(
  uid: string,
  data: unknown,
  action: string,
): WriteLockDomain[] {
  if (action === 'delete') {
    // A Store/Brand delete clears checkoutMerchant references in its content
    // transaction — the affiliate domain serializes that against offer
    // writes validating the target. The identity lock is deliberately NOT
    // taken: deletion FREES identifiers (no uniqueness race to serialize),
    // and identity is the hottest domain — holding it fail-closed across a
    // delete's relation cascade would reject every concurrent taxonomy save
    // that outwaits lock_timeout.
    return isAffiliateEntityUid(uid) ? ['affiliate'] : [];
  }
  if (uid === 'api::brand.brand') return ['affiliate', 'identity'];
  if (
    uid === 'api::store.store' &&
    (touchesEntityOfferRelations(data) || action === 'clone')
  ) {
    // A store CLONE inherits the source's coupons/deals connections without
    // the payload ever naming them — same reason offer clones lock below.
    return ['affiliate', 'identity'];
  }
  if (isIdentityUid(uid)) return ['identity'];
  if (uid === 'api::redirect.redirect') return ['redirect'];
  if (uid === JOB_UID) return ['job'];
  if (
    isOfferStoreUid(uid) &&
    (touchesAffiliateFields(data) || action === 'clone')
  ) {
    return ['affiliate'];
  }
  return [];
}
