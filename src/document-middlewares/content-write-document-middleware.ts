import type { Core } from '@strapi/strapi';

import { purgeEntityPopularSearchCatalog } from '../api/store/services/entity-popular-searches';
import { logIsrOutbox } from '../isr-outbox/log';
import { outboxPayloadSummary } from '../isr-outbox/payload';
import { wakeIsrOutbox } from '../isr-outbox/runtime';
import { runContentTransaction } from '../isr-outbox/transaction';
import { purgeResponseCaches } from '../middlewares/cache';
import { runWriteValidation } from '../utils/write-validation/run';
import { applyTransactionalMaintenance } from './apply-transactional-maintenance';
import { buildWriteInvalidation } from './build-write-invalidation';
import { captureWriteSnapshot } from './capture-write-snapshot';
import { prepareCloneRelationOverrides } from './clone-relation-overrides';
import type { DocumentWriteContext } from './content-write-types';

const DOCUMENT_WRITE_ACTIONS = new Set([
  'create',
  'clone',
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
]);

export function createContentWriteDocumentMiddleware(strapi: Core.Strapi) {
  return async function contentWriteDocumentMiddleware(
    context: DocumentWriteContext,
    next: any,
  ) {
    if (!DOCUMENT_WRITE_ACTIONS.has(context.action)) return next();

    // A clone may arrive with NO payload while Strapi still deep-copies the
    // source. Give it a real (empty) data object BEFORE validation so the
    // validators' write-through mutations — canonicalizing an inherited
    // checkoutMerchant, blank→null — land in the object the write consumes.
    if (context.action === 'clone') {
      (context as any).params ??= {};
      if ((context as any).params.data == null) {
        (context as any).params.data = {};
      }
    }

    // Normalise the payload, then run every editor-facing validator and
    // report ALL of their problems in one error — see
    // src/utils/write-validation/run.ts for the pipeline and
    // src/utils/write-validation/steps.ts for the ordered step registry.
    //
    // Slug and redirect invariants are validated with plain reads and
    // committed by an INDEPENDENT write — two concurrent saves can both pass
    // validation on the same committed snapshot and both commit. A unique
    // index on the NORMALIZED values cannot be added over legacy duplicates
    // (identity-validation.ts), so the pipeline serializes that window with
    // one advisory-lock transaction per save, and hands the release back
    // here because the locks must stay held until the write below has
    // COMMITTED. No-op on non-Postgres; on lock failure a fail-open domain
    // set proceeds unserialized, a fail-closed one rejects the save.
    const releaseWriteLock = await runWriteValidation(strapi, context as any);
    try {
      const snapshot = await captureWriteSnapshot(strapi, context);
      return await runContentTransaction(
        strapi,
        async (trx) => {
          const prepared = await prepareCloneRelationOverrides(
            strapi,
            context,
            trx,
          );
          try {
            const result = await next();
            // Still inside the transaction: a clone whose overridden
            // relations did not survive Strapi's merge is rolled back loudly
            // instead of committing silently-wrong relation sets.
            await prepared.verify(result);
            return result;
          } finally {
            // Snapshot/invalidation code after the write must see the original
            // caller payload, not the temporary clone-safe numeric array.
            prepared.restore();
          }
        },
        async (result, trx) => {
          const maintenance = await applyTransactionalMaintenance(
            strapi,
            context,
            result,
            trx,
            snapshot,
          );
          return buildWriteInvalidation(
            strapi,
            context,
            snapshot,
            maintenance,
          );
        },
        (event) => {
          if (!event) return;
          // Only after the database commit: renderers must never observe
          // invalidation before the content and its durable outbox event.
          purgeResponseCaches();
          purgeEntityPopularSearchCatalog();
          logIsrOutbox(strapi, 'info', 'isr.outbox.enqueued', {
            outboxId: event.id,
            eventKey: event.eventKey,
            reason: event.reason,
            payload: outboxPayloadSummary(event.payload),
            uid: context.uid,
            action: context.action,
          });
          wakeIsrOutbox();
        },
      );
    } finally {
      if (releaseWriteLock) await releaseWriteLock();
    }
  };
}
