import type { Core } from '@strapi/strapi';

import {
  createOutboxPayload,
  mergeScope,
  offerEntityTypeFromUid,
} from '../isr-outbox/payload';
import { logIsrOutbox } from '../isr-outbox/log';
import {
  entityPublicIdentityChanged,
  isPopularSearchEntityUid,
} from '../isr-outbox/popular-search-invalidation';
import {
  computeScope,
  isRedirectNoteOnlyChange,
  offerRelationScope,
  withOfferLandingSlugs,
} from '../isr-outbox/scopes';
import type { OfferInvalidation } from '../isr-outbox/types';
import {
  diffEntityOfferSnapshots,
  EMPTY_ENTITY_OFFER_SNAPSHOT,
  isAffiliateEntityUid,
  snapshotEntityOfferRelations,
} from '../utils/affiliate-brand-validation';
import type {
  DocumentWriteContext,
  TransactionalMaintenance,
  WriteSnapshot,
} from './content-write-types';

export async function buildWriteInvalidation(
  strapi: Core.Strapi,
  context: DocumentWriteContext,
  snapshot: WriteSnapshot,
  maintenance: TransactionalMaintenance,
) {
  const { documentId } = maintenance;
  const afterScope =
    context.action === 'delete' && snapshot.preScope
      ? null
      : await computeScope(
          strapi,
          context.uid,
          context.action,
          documentId,
          context.params?.data,
          snapshot.festiveOfferBefore,
        );
  let scope =
    context.action === 'delete'
      ? snapshot.preScope ?? afterScope
      : mergeScope(snapshot.preScope, afterScope);

  if (
    snapshot.entityIdentityBefore &&
    isPopularSearchEntityUid(context.uid) &&
    documentId
  ) {
    const entityIdentityAfter: any = await strapi
      .documents(context.uid as any)
      .findOne({
        documentId,
        fields: ['name', 'slug'] as any,
      });
    if (
      entityPublicIdentityChanged(
        snapshot.entityIdentityBefore,
        entityIdentityAfter,
      )
    ) {
      scope = mergeScope(scope, {
        full: true,
        refreshScopes: ['routes'],
      });
    }
  }

  if (
    scope &&
    snapshot.redirectBefore &&
    isRedirectNoteOnlyChange(
      snapshot.redirectBefore,
      context.params?.data,
    )
  ) {
    logIsrOutbox(
      strapi,
      'info',
      'isr.outbox.redirect_note_only_skipped',
      { uid: context.uid, action: context.action, documentId },
    );
    scope = null;
  }

  await maintenance.removeInactiveCuratedOffer();

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

  const reroutedOffers = new Map<
    string,
    {
      uid: 'api::coupon.coupon' | 'api::deal.deal';
      documentId: string;
    }
  >();
  if (maintenance.affiliateCascade) {
    for (const offer of maintenance.affiliateCascade.affected) {
      reroutedOffers.set(`${offer.uid}:${offer.documentId}`, offer);
    }
  }
  if (snapshot.entityOfferSweep && isAffiliateEntityUid(context.uid)) {
    if (snapshot.entityOffersBefore === null || !documentId) {
      scope = mergeScope(scope, { full: true });
    } else if (context.action === 'delete') {
      // The document is gone — every pre-delete member changed, and so did
      // every offer whose checkoutMerchant pointed at it (nulled by
      // clearDeletedCheckoutMerchant inside this same transaction).
      for (const offer of diffEntityOfferSnapshots(
        snapshot.entityOffersBefore,
        EMPTY_ENTITY_OFFER_SNAPSHOT,
      )) {
        reroutedOffers.set(`${offer.uid}:${offer.documentId}`, offer);
      }
    } else {
      try {
        const entityOffersAfter = await snapshotEntityOfferRelations(
          strapi,
          context.uid,
          documentId,
        );
        for (const offer of diffEntityOfferSnapshots(
          snapshot.entityOffersBefore,
          entityOffersAfter,
        )) {
          reroutedOffers.set(`${offer.uid}:${offer.documentId}`, offer);
        }
      } catch (err: any) {
        strapi.log.warn(
          `[affiliate-brand] offer membership diff failed for ` +
            `${context.uid} ${documentId}: ${err?.message ?? err}`,
        );
        scope = mergeScope(scope, { full: true });
      }
    }
  }
  for (const offer of snapshot.merchantReferencedOffers) {
    reroutedOffers.set(`${offer.uid}:${offer.documentId}`, offer);
  }

  if (reroutedOffers.size > 0) {
    // Each scope read is ~5 queries serialized on the ambient transaction
    // connection while the advisory locks are held — past the cap, one full
    // rebuild is cheaper than stretching every waiter's lock window.
    const REROUTED_OFFER_SCOPE_CAP = 10;
    if (reroutedOffers.size > REROUTED_OFFER_SCOPE_CAP) {
      scope = mergeScope(scope, { full: true });
    } else {
      for (const offer of reroutedOffers.values()) {
        const offerScope = await offerRelationScope(
          strapi,
          offer.uid,
          offer.documentId,
        );
        scope = mergeScope(
          scope,
          offerScope
            ? {
                slugs: withOfferLandingSlugs(offer.uid, offerScope.slugs),
                ...(offerScope.optionalSlugs.length > 0
                  ? { optionalSlugs: offerScope.optionalSlugs }
                  : {}),
              }
            : { full: true },
        );
      }
    }
    for (const offer of reroutedOffers.values()) {
      const offerEntityType = offerEntityTypeFromUid(offer.uid);
      if (offerEntityType) {
        offerInvalidations.push({
          entityType: offerEntityType,
          documentId: offer.documentId,
        });
      }
    }
  }

  if (!scope && offerInvalidations.length === 0) return null;
  return {
    payload: createOutboxPayload(scope ?? {}, offerInvalidations),
    reason: `${context.uid} ${context.action}`,
  };
}
