import type { Core } from '@strapi/strapi';
import { purgeResponseCaches } from '../middlewares/cache';
import {
  createOutboxPayload,
  expandPayloadPathsForLocales,
  localizeTranslationPayload,
  mergeScope,
  offerEntityTypeFromUid,
  outboxPayloadSummary,
} from '../isr-outbox/payload';
import { logIsrOutbox } from '../isr-outbox/log';
import { wakeIsrOutbox } from '../isr-outbox/runtime';
import { runContentTransaction } from '../isr-outbox/transaction';
import {
  entityPublicIdentityChanged,
  isPopularSearchEntityUid,
} from '../isr-outbox/popular-search-invalidation';
import {
  purgeEntityPopularSearchCatalog,
} from '../api/store/services/entity-popular-searches';
import type {
  OfferInvalidation,
  ScopeRequest,
} from '../isr-outbox/types';
import {
  computeScope,
  isRedirectNoteOnlyChange,
} from '../isr-outbox/scopes';
import { preDeleteScope } from '../isr-outbox/offer-relation-scopes';
import {
  FESTIVE_OFFER_ENTITY_UIDS,
  type FestiveOfferSnapshot,
} from '../isr-outbox/festive-offer-scopes';
// Every write validator now runs through this one pipeline, which reports all
// of their problems in a single error instead of the first one it hits.
import { runWriteValidation } from '../utils/write-validation/run';
import { removeInactiveCuratedOfferRelations } from '../utils/curated-offer-cleanup';
import {
  changesEntityOfferMembership,
  touchEntityPageUpdatedAt,
} from '../utils/entity-page-timestamp';
import { CHECKOUT_MERCHANT_FIELD } from '../constants/checkout-merchant';
import { clearDeletedCheckoutMerchant } from '../utils/checkout-merchant-validation';
import { fillHomepageOverrides } from '../utils/homepage-override-fill';
import { DOCUMENT_WRITE_ACTIONS } from '../constants/document-write';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import {
  isTranslationWrite,
  translationWriteContext,
} from '../translation/write-flag';
import {
  translationRuntimeActive,
  wakeTranslationOutbox,
} from '../translation/outbox/runtime';
import {
  insertTranslationJob,
  TRANSLATION_STATE_TABLE,
} from '../translation/outbox/store';
import { enabledContentLocales } from '../translation/locales/registry';
import {
  hasSharedFieldSelection,
  loadSharedFieldSnapshot,
  sharedFieldSelection,
  sharedFieldSnapshotsDiffer,
} from '../isr-outbox/localized-change';

// The document-write pipeline: the one document-service middleware every
// editor-facing write flows through. In order: pre-write validation
// (write-validation steps), pre-state capture for scope/identity diffs,
// the content transaction (the write itself + the in-transaction data
// integrity side-effects + the durable ISR outbox insert), and post-commit
// process-local cache purges. ISR scope/payload/dispatch logic stays in
// src/isr-outbox/; this module owns the orchestration.
export function installDocumentWriteMiddleware(strapi: Core.Strapi): void {
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
      let translationEnqueued = false;
      let festiveOfferBefore: FestiveOfferSnapshot | null = null;
      if (
        context.action === 'update' &&
        FESTIVE_OFFER_ENTITY_UIDS.has(context.uid) &&
        context.params?.documentId
      ) {
        try {
          // Same locale as the write: festive title/description are
          // localized, so an `ar` save compared against the `en` snapshot
          // would read as "festive edited" and wrongly escalate every
          // translation write to a full-site rebuild.
          festiveOfferBefore = await strapi.documents(context.uid).findOne({
            documentId: context.params.documentId,
            ...(context.params?.locale
              ? { locale: context.params.locale }
              : {}),
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

      // Content Manager updates resend the full form, including every shared
      // slug/visibility/media field. Field presence is therefore not evidence
      // of change: compare the persisted before/after values so an English
      // title-only edit does not invalidate Arabic before its translation is
      // ready. Unknown/read-failed state deliberately falls back to all-locale
      // invalidation.
      const localizedModel = strapi.getModel(context.uid as any) as any;
      const localizedType =
        localizedModel?.pluginOptions?.i18n?.localized === true;
      const sharedSelection = sharedFieldSelection(
        localizedModel,
        context.params?.data,
      );
      let sharedBefore: Record<string, unknown> | null = null;
      if (
        localizedType &&
        context.action === 'update' &&
        context.params?.documentId &&
        hasSharedFieldSelection(sharedSelection)
      ) {
        try {
          sharedBefore = await loadSharedFieldSnapshot(
            strapi,
            context.uid,
            context.params.documentId,
            context.params?.locale,
            sharedSelection,
          );
        } catch {
          sharedBefore = null;
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

          // AI translation: a default-locale write to a localized type
          // enqueues one coalesced job per enabled target locale, in THIS
          // transaction — the job either commits with the content or not at
          // all. The dispatcher's own locale writes are excluded twice over
          // (non-default locale + the AsyncLocalStorage write flag). Fully
          // inert unless the site opted in AND the env parses
          // (translationRuntimeActive), so India/USA never see a row.
          try {
            const writesDefaultLocale =
              !context.params?.locale ||
              context.params.locale === DEFAULT_CONTENT_LOCALE;
            const localizedType =
              (strapi.getModel(context.uid as any) as any)?.pluginOptions?.i18n
                ?.localized === true;
            if (localizedType && documentId) {
              if (context.action === 'delete') {
                const deletedLocale = String(
                  context.params?.locale ?? DEFAULT_CONTENT_LOCALE,
                );
                const stateRows = trx(TRANSLATION_STATE_TABLE).where({
                  uid: context.uid,
                  document_id: documentId,
                });
                // Strapi deletes one locale unless the caller explicitly
                // uses locale="*". A target-locale delete must therefore
                // retain the source and every sibling locale's memory.
                if (
                  deletedLocale !== DEFAULT_CONTENT_LOCALE &&
                  deletedLocale !== '*'
                ) {
                  stateRows.andWhere({ locale: deletedLocale });
                }
                await stateRows.delete();
                if (
                  deletedLocale === DEFAULT_CONTENT_LOCALE &&
                  !isTranslationWrite() &&
                  (await translationRuntimeActive(strapi))
                ) {
                  // Durable cleanup: the dispatcher sees that the English
                  // source is gone and removes each generated locale through
                  // the documents API, including all component/relation rows.
                  for (const locale of await enabledContentLocales(strapi)) {
                    await insertTranslationJob(trx, {
                      uid: context.uid,
                      documentId,
                      targetLocale: locale.code,
                      kind: 'translate',
                      reason: `${context.uid} delete`,
                    });
                  }
                  translationEnqueued = true;
                }
              } else if (
                writesDefaultLocale &&
                !isTranslationWrite() &&
                ['create', 'update', 'clone', 'publish'].includes(context.action) &&
                (await translationRuntimeActive(strapi))
              ) {
                for (const locale of await enabledContentLocales(strapi)) {
                  await insertTranslationJob(trx, {
                    uid: context.uid,
                    documentId,
                    targetLocale: locale.code,
                    kind: 'translate',
                    reason: `${context.uid} ${context.action}`,
                  });
                }
                translationEnqueued = true;
              }
            }
          } catch (err: any) {
            // The job is the durable continuation of this English write.
            // Failing the transaction is safer than committing content that
            // can never be translated (the nightly audit is deliberately
            // optional and is not a delivery mechanism).
            strapi.log.error(
              `[translation] enqueue failed for ${context.uid} ${documentId}: ` +
                `${err?.message ?? err}`,
            );
            throw err;
          }

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
          // No action check here: the middleware's entry gate already
          // restricted context.action to DOCUMENT_WRITE_ACTIONS.
          if (entityType && documentId) {
            offerInvalidations.push({ entityType, documentId });
          }

          if (!scope && offerInvalidations.length === 0) return null;
          const payload = createOutboxPayload(
            scope ?? {},
            offerInvalidations,
          );
          const targetLocale = String(
            context.params?.locale ?? DEFAULT_CONTENT_LOCALE,
          );
          const translation = translationWriteContext();
          const sharedChange = await (async () => {
            if (!localizedType || isTranslationWrite()) return false;
            if (targetLocale === '*') return true;
            if (['publish', 'unpublish'].includes(context.action)) return true;
            if (context.action !== 'update') return false;
            if (sharedSelection.unknown) return true;
            if (!hasSharedFieldSelection(sharedSelection)) return false;
            try {
              const after = documentId
                ? await loadSharedFieldSnapshot(
                    strapi,
                    context.uid,
                    documentId,
                    context.params?.locale,
                    sharedSelection,
                  )
                : null;
              return sharedFieldSnapshotsDiffer(sharedBefore, after);
            } catch {
              return true;
            }
          })();
          if (
            localizedType &&
            !sharedChange &&
            targetLocale !== DEFAULT_CONTENT_LOCALE &&
            targetLocale !== '*'
          ) {
            const localizedPayload = localizeTranslationPayload(
              payload,
              targetLocale,
              {
                routeMembershipChanged:
                  translation
                    ? !translation.targetRowExisted ||
                      translation.operation === 'delete'
                    : ['create', 'delete'].includes(context.action),
              },
            );
            return {
              payload: localizedPayload,
              reason: `${context.uid} ${context.action}`,
              ...(translation
                ? { eventKey: `translation-isr:${targetLocale}` }
                : {}),
            };
          }
          return {
            payload: sharedChange
              ? expandPayloadPathsForLocales(
                  payload,
                  (await enabledContentLocales(strapi)).map((locale) => locale.code),
                )
              : payload,
            reason: `${context.uid} ${context.action}`,
          };
        },
        (event) => {
          // Only after the database commit — the job row is durable now.
          if (translationEnqueued) wakeTranslationOutbox();
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
