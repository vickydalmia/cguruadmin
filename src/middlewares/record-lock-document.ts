import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { RECORD_LOCK_LEASE_HEADER } from '../constants/record-lock';

// Write actions the edit lock guards. `create`/`clone` are absent on purpose:
// for collection types they have no existing documentId, so there is nothing
// to lock. Single types are the exception — their first-ever save IS a
// create, and the middleware enforces that case separately.
const LOCK_ENFORCED_ACTIONS = new Set([
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
]);

// Enforce edit locks server-side. The RecordLockPanel warning alone would
// be advisory — an admin who ignores it (or opened the entry before the
// panel loaded) could still overwrite the holder's work. Scoped to
// Content Manager requests carrying an admin user so crons, the ISR
// outbox, redeem flows and other server-initiated writes are untouched.
export function installRecordLockDocumentMiddleware(strapi: Core.Strapi): void {
  strapi.documents.use(async (context: any, next: any) => {
    // Cheap action gate FIRST: this middleware sits in front of every
    // document-service call — findMany/findOne/count on public API
    // requests, crons, the ISR outbox — and getModel() is an O(registry)
    // scan, so it must only run for actions that can possibly be enforced.
    const enforceable =
      LOCK_ENFORCED_ACTIONS.has(context.action) ||
      context.action === 'create';
    if (!enforceable) return next();
    const isSingleType =
      strapi.getModel(context.uid as any)?.kind === 'singleType';
    // Single types additionally enforce `create`: their FIRST-ever save
    // runs as the create action (no document row exists yet), but they are
    // locked regardless of existence — without this, two admins could race
    // on a never-saved single type straight past each other's lock.
    // Collection-type create stays exempt: nothing exists to lock.
    if (context.action === 'create' && !isSingleType) return next();
    const documentId = context.params?.documentId;
    if (
      !isSingleType &&
      (typeof documentId !== 'string' || documentId === '')
    ) {
      return next();
    }
    const ctx = strapi.requestContext.get();
    const user = ctx?.state?.user;
    if (!user || !ctx?.request?.url?.startsWith('/content-manager/')) {
      return next();
    }
    // The record-lock service resolves the single-type pseudo id itself —
    // pass documentId through as-is (undefined for single types).
    const holder = await strapi
      .service('api::record-lock.record-lock')
      .activeHolder(context.uid, isSingleType ? undefined : documentId);
    // No active lock: ALLOW. Locks exist only while an edit view is open
    // on this entry — list-view row delete, bulk publish/unpublish and
    // plugin content types (which the panel never locks) all arrive
    // without one and must keep working. This guard's only job is to
    // protect a HELD lock from every other session.
    if (!holder) return next();
    if (holder.adminUserId !== user.id) {
      throw new errors.ApplicationError(
        `This entry is currently being edited by ${holder.holderName}. ` +
          'Come back later — your change was NOT saved.',
      );
    }
    const leaseId =
      ctx.get?.(RECORD_LOCK_LEASE_HEADER) ??
      ctx.request?.headers?.[RECORD_LOCK_LEASE_HEADER];
    if (typeof leaseId !== 'string' || holder.leaseId !== leaseId) {
      // Same admin, but the write does not come from the tab holding the
      // lease (another tab, a list-view bulk action, a reload's new
      // session) — the holding tab's work must not be overwritten.
      throw new errors.ApplicationError(
        'This entry is locked by another of your browser tabs. Your change ' +
          'was NOT saved. Finish there, or use "Take over editing here" on ' +
          'this entry’s edit screen.',
      );
    }
    return next();
  });
}
