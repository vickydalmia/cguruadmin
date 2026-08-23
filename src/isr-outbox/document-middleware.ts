import type { Core } from '@strapi/strapi';
import { purgeResponseCaches } from '../middlewares/cache';
import {
  createOutboxPayload,
  mergeScope,
  offerEntityTypeFromUid,
  outboxPayloadSummary,
} from './payload';
import { logIsrOutbox } from './log';
import { wakeIsrOutbox } from './runtime';
import { runContentTransaction } from './transaction';
import {
  entityPublicIdentityChanged,
  isPopularSearchEntityUid,
} from './popular-search-invalidation';
import {
  purgeEntityPopularSearchCatalog,
} from '../api/store/services/entity-popular-searches';
import type {
  OfferInvalidation,
  ScopeRequest,
} from './types';
import {
  computeScope,
  FESTIVE_OFFER_ENTITY_UIDS,
  isRedirectNoteOnlyChange,
  preDeleteScope,
  type FestiveOfferSnapshot,
} from './scopes';
// Every write validator now runs through this one pipeline, which reports all
// of their problems in a single error instead of the first one it hits.
import { runWriteValidation } from '../utils/write-validation/run';
import { removeInactiveCuratedOfferRelations } from '../utils/curated-offer-relations';
import {
  changesEntityOfferMembership,
  touchEntityPageUpdatedAt,
} from '../utils/entity-page-timestamp';
import { CHECKOUT_MERCHANT_FIELD } from '../constants/checkout-merchant';
import { clearDeletedCheckoutMerchant } from '../utils/checkout-merchant-validation';
import { fillHomepageOverrides } from '../utils/homepage-override-fill';

const DOCUMENT_WRITE_ACTIONS = new Set([
  'create',
  'clone',
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
]);

// The write-validation + ISR-outbox document-service middleware: normalises
// and validates every editor-facing write, wraps it in the content
// transaction that enqueues the durable outbox event, and purges the
// process-local caches only after commit.
export function installIsrDocumentMiddleware(strapi: Core.Strapi): void {
  strapi.documents.use(async (context: any, next: any) => {
    if (!DOCUMENT_WRITE_ACTIONS.has(context.action)) return next();

    // Normalise the payload, then run every editor-facing validator and
    // report ALL of their problems in one error — see
    // src/utils/write-validation/run.ts for the pipeline and
    // src/utils/write-validation/steps.ts for the ordered step registry.
    // Before this was extracted, twelve validators were awaited inline here
    // and the first to throw hid the other eleven, so an editor fixed one
    // problem per save.
    //
    // Slug and redirect invariants are validated with plain reads and
    // committed by an INDEPENDENT write — two concurrent saves can both pass
    // validation on the same committed snapshot and both commit: one flat
    // route claimed by two taxonomy types (the ISR server silently drops the
    // loser), case-folded duplicate redirect `from`s, or /a→/b + /b→/a
    // closing a cycle. A unique index on the NORMALIZED values cannot be
    // added over legacy duplicates (identity-validation.ts), so the pipeline
    // serializes that window with one advisory lock per invariant domain,
    // and hands the release back here because the lock must stay held until
    // the write below has COMMITTED. No-op on non-Postgres; on lock failure
    // the save proceeds unserialized (the pre-existing rare race, never an
    // outage).
    const releaseWriteLock = await runWriteValidation(strapi, context);
    try {
      // Redirect `note` is editor-only metadata, but the redirect UID scopes
      // to a FULL sweep (scopes.ts). Read the material fields before the
      // write so a note-only edit can skip the rebuild entirely (redirects
      // have draftAndPublish:false — update IS the live write). A failed
      // read means unknown before-state → keep the sweep.
      let redirectBefore: Record<string, unknown> | null = null;
      if (
        context.uid === 'api::redirect.redirect' &&
        context.action === 'update' &&
        context.params?.documentId
      ) {
        try {
          redirectBefore = await strapi
            .documents('api::redirect.redirect')
            .findOne({
              documentId: context.params.documentId,
              fields: ['from', 'to', 'statusCode', 'active'] as any,
            });
        } catch {
          redirectBefore = null;
        }
      }

      // Was this offer live before the write? Only the expiry cron feeds
      // `changedOffers`, so an editor unpublishing by hand in Content
      // Manager reached no cleanup at all and left the coupon sitting in
      // curated relations until the NIGHTLY full scan — up to a day of a
      // dead Top Pick in a layout, and a layout the save then refused.
      // Expiry and delete were already covered (the cron flips status and
      // feeds itself; deletes cascade); this closes the remaining path.
      let offerWasPublished = false;
      if (
        offerEntityTypeFromUid(context.uid) &&
        context.params?.documentId &&
        ['update', 'unpublish', 'discardDraft'].includes(context.action)
      ) {
        try {
          const before: any = await strapi
            .documents(context.uid)
            .findOne({
              documentId: context.params.documentId,
              fields: ['contentStatus'] as any,
            });
          offerWasPublished = before?.contentStatus === 'published';
        } catch {
          offerWasPublished = false;
        }
      }

      // Offer changes: capture relations BEFORE the write. For deletes the
      // doc disappears entirely; for updates a relation may be REMOVED — the
      // removed store/bank/category/brand page must also rebuild, so the
      // final scope is the union of before + after relations.
      let preScope: ScopeRequest | null = null;
      if (['delete', 'update', 'publish', 'unpublish', 'discardDraft'].includes(context.action)) {
        try {
          preScope = await preDeleteScope(
            strapi,
            context.uid,
            context.params?.documentId,
            context.action
          );
        } catch {
          preScope = null;
        }
      }

      let entityIdentityBefore: { name?: unknown; slug?: unknown } | null = null;
      if (
        context.action === 'update' &&
        isPopularSearchEntityUid(context.uid) &&
        context.params?.documentId
      ) {
        try {
          entityIdentityBefore = await strapi.documents(context.uid).findOne({
            documentId: context.params.documentId,
            fields: ['name', 'slug'] as any,
          });
        } catch {
          entityIdentityBefore = null;
        }
      }

      // Festive fields BEFORE the write. The content-manager form submits
      // the full document, so computeScope cannot tell "festive edited"
      // from "festive merely present" by looking at the payload — without
      // this snapshot every Store/Brand save would escalate to a full-site
      // rebuild (see festiveOfferChanged in isr-outbox/scopes.ts). A failed
      // read stays null, which fails toward invalidation, never away.
      let festiveOfferBefore: FestiveOfferSnapshot | null = null;
      if (
        context.action === 'update' &&
        FESTIVE_OFFER_ENTITY_UIDS.has(context.uid) &&
        context.params?.documentId
      ) {
        try {
          festiveOfferBefore = await strapi.documents(context.uid).findOne({
            documentId: context.params.documentId,
            fields: [
              'isFestiveOffer',
              'festiveOfferTitle',
              'festiveOfferDescription',
            ] as any,
          });
        } catch {
          festiveOfferBefore = null;
        }
      }

      return await runContentTransaction(
        strapi,
        () => next(),
        async (result, trx) => {
          if (
            context.action === 'update' &&
            changesEntityOfferMembership(context.uid, context.params?.data)
          ) {
            // `trx`, not a pool connection: the write above still holds this
            // row's lock until this callback returns, so a second connection
            // touching it would deadlock with no timeout.
            await touchEntityPageUpdatedAt(
              strapi,
              trx,
              context.uid,
              result,
              context.params?.documentId,
            );
          }

          // checkoutMerchant is a custom STRING field, not a relation, so
          // deleting a Store or Brand leaves every offer that pointed at it
          // holding a reference to a row that is gone — the one thing a
          // foreign key's ON DELETE SET NULL would have handled for free.
          // Do it by hand, in this transaction, so the clear commits with
          // the delete or not at all.
          //
          // strapi.db.query joins the ambient transaction through
          // AsyncLocalStorage (AGENTS.md); a raw strapi.db.connection write
          // here would take a second pool connection and deadlock against
          // the row locks the delete still holds.
          if (
            context.action === 'delete' &&
            context.params?.documentId &&
            (context.uid === 'api::store.store' ||
              context.uid === 'api::brand.brand')
          ) {
            try {
              const cleared = await clearDeletedCheckoutMerchant(
                strapi,
                context.uid === 'api::store.store' ? 'store' : 'brand',
                context.params.documentId,
              );
              if (cleared > 0) {
                strapi.log.info(
                  `[${CHECKOUT_MERCHANT_FIELD}] cleared ${cleared} offer ` +
                    `reference(s) to deleted ${context.uid} ` +
                    `${context.params.documentId}`,
                );
              }
            } catch (err: any) {
              // Never block the delete on the cleanup. A leftover reference
              // is caught by validateCheckoutMerchantForWrite on the next
              // save of that offer, which is a recoverable state; a delete
              // that half-fails inside a content transaction is not.
              strapi.log.warn(
                `[${CHECKOUT_MERCHANT_FIELD}] cleanup failed for ` +
                  `${context.uid} ${context.params.documentId}: ` +
                  `${err?.message ?? err}`,
              );
            }
          }

          if (
            [
              'api::homepage.homepage',
              'api::deal-of-the-day-page.deal-of-the-day-page',
              'api::independence-day-sale-page.independence-day-sale-page',
            ].includes(context.uid) &&
            ['create', 'update', 'publish'].includes(context.action)
          ) {
            try {
              await fillHomepageOverrides(strapi);
            } catch (err: any) {
              strapi.log.warn(
                `[homepage] override auto-fill failed: ${err?.message ?? err}`,
              );
            }
          }

          const documentId =
            (result as any)?.documentId ?? context.params?.documentId;
          const afterScope =
            context.action === 'delete' && preScope
              ? null
              : await computeScope(
                  strapi,
                  context.uid,
                  context.action,
                  documentId,
                  context.params?.data,
                  festiveOfferBefore,
                );
          let scope =
            context.action === 'delete'
              ? preScope ?? afterScope
              : mergeScope(preScope, afterScope);

          if (
            entityIdentityBefore &&
            isPopularSearchEntityUid(context.uid) &&
            documentId
          ) {
            const entityIdentityAfter: any = await strapi
              .documents(context.uid)
              .findOne({
                documentId,
                fields: ['name', 'slug'] as any,
              });
            if (
              entityPublicIdentityChanged(
                entityIdentityBefore,
                entityIdentityAfter,
              )
            ) {
              scope = mergeScope(scope, {
                full: true,
                refreshScopes: ['routes'],
              });
            }
          }

          // Popular-search leaderboard change detection was removed here by
          // deliberate product decision: it cost two full live-catalogue
          // scans per qualifying offer write (one inside this transaction)
          // solely to broadcast {full:true} when the global top-10 fallback
          // shifted. Sparse pages' borrowed rail may now drift until the
          // nightly unconditional {all:true} consistency event re-renders
          // everything (config/cron-tasks.ts) — an accepted ≤24h bound.

          if (
            scope &&
            redirectBefore &&
            isRedirectNoteOnlyChange(redirectBefore, context.params?.data)
          ) {
            logIsrOutbox(
              strapi,
              'info',
              'isr.outbox.redirect_note_only_skipped',
              { uid: context.uid, action: context.action, documentId },
            );
            scope = null;
          }

          // Strip this offer out of curated relations the moment it stops
          // being live. Runs INSIDE the write transaction (the Query Engine
          // picks up the ambient one), so a renderer can never observe the
          // page mid-way: either the unpublish and the relation removal are
          // both visible, or neither is. The entity pages are already in
          // `preScope`, so this needs no extra invalidation of its own.
          if (offerWasPublished && documentId) {
            try {
              const after: any = await strapi
                .documents(context.uid)
                .findOne({
                  documentId,
                  fields: ['contentStatus'] as any,
                });
              if (after && after.contentStatus !== 'published') {
                await removeInactiveCuratedOfferRelations(strapi, new Date(), {
                  [context.uid]: [documentId],
                } as any);
              }
            } catch (err: any) {
              // Never fail the editor's write for this: the five-minute and
              // nightly passes still converge.
              strapi.log.warn(
                `[curated-offers] inline cleanup failed for ${context.uid} ${documentId}: `
                + `${err?.message ?? err}`,
              );
            }
          }

          const offerInvalidations: OfferInvalidation[] = [];
          const entityType = offerEntityTypeFromUid(context.uid);
          if (
            entityType &&
            documentId &&
            [
              'create',
              'clone',
              'update',
              'publish',
              'unpublish',
              'discardDraft',
              'delete',
            ].includes(context.action)
          ) {
            offerInvalidations.push({ entityType, documentId });
          }

          if (!scope && offerInvalidations.length === 0) return null;
          return {
            payload: createOutboxPayload(scope ?? {}, offerInvalidations),
            reason: `${context.uid} ${context.action}`,
          };
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
  });
}
