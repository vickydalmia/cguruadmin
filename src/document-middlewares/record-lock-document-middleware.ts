import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

import { RECORD_LOCK_LEASE_HEADER } from '../constants/record-lock';

// Write actions the edit lock guards. `create`/`clone` are absent on purpose:
// for collection types they have no existing documentId, so there is nothing
// to lock. Single types are the exception — their first-ever save IS a
// create, and the middleware enforces that case separately below.
const LOCK_ENFORCED_ACTIONS = new Set([
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
]);

export function createRecordLockDocumentMiddleware(strapi: Core.Strapi) {
  return async function recordLockDocumentMiddleware(
    context: any,
    next: any,
  ) {
    const enforceable =
      LOCK_ENFORCED_ACTIONS.has(context.action) || context.action === 'create';
    if (!enforceable) return next();
    const isSingleType =
      strapi.getModel(context.uid as any)?.kind === 'singleType';
    if (context.action === 'create' && !isSingleType) return next();
    const documentId = context.params?.documentId;
    if (
      !isSingleType &&
      (typeof documentId !== 'string' || documentId === '')
    ) {
      return next();
    }
    const requestContext = strapi.requestContext.get();
    const user = requestContext?.state?.user;
    if (
      !user ||
      !requestContext?.request?.url?.startsWith('/content-manager/')
    ) {
      return next();
    }
    const holder = await strapi
      .service('api::record-lock.record-lock')
      .activeHolder(context.uid, isSingleType ? undefined : documentId);
    if (!holder) return next();
    if (holder.adminUserId !== user.id) {
      throw new errors.ApplicationError(
        `This entry is currently being edited by ${holder.holderName}. ` +
          'Come back later — your change was NOT saved.',
      );
    }
    const leaseId =
      requestContext.get?.(RECORD_LOCK_LEASE_HEADER) ??
      requestContext.request?.headers?.[RECORD_LOCK_LEASE_HEADER];
    if (typeof leaseId !== 'string' || holder.leaseId !== leaseId) {
      throw new errors.ApplicationError(
        'This entry is locked by another of your browser tabs. Your change ' +
          'was NOT saved. Finish there, or use "Take over editing here" on ' +
          'this entry’s edit screen.',
      );
    }
    return next();
  };
}
