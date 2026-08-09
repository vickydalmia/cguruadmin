import type { Core } from '@strapi/strapi';

import {
  CHECKOUT_MERCHANT_FIELD,
  formatCheckoutMerchant,
} from '../constants/checkout-merchant';
import { OFFER_STORE_UIDS } from '../utils/content-manager-offer-store-validation';
import { offerEntityTypeFromUid } from '../isr-outbox/payload';
import {
  FESTIVE_OFFER_ENTITY_UIDS,
  preDeleteScope,
} from '../isr-outbox/scopes';
import { isPopularSearchEntityUid } from '../isr-outbox/popular-search-invalidation';
import {
  EMPTY_ENTITY_OFFER_SNAPSHOT,
  isAffiliateEntityUid,
  snapshotEntityOfferRelations,
  touchesEntityOfferRelations,
} from '../utils/affiliate-brand-validation';
import type { DocumentWriteContext, WriteSnapshot } from './content-write-types';

export async function captureWriteSnapshot(
  strapi: Core.Strapi,
  context: DocumentWriteContext,
): Promise<WriteSnapshot> {
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

  let offerWasPublished = false;
  if (
    offerEntityTypeFromUid(context.uid) &&
    context.params?.documentId &&
    ['update', 'unpublish', 'discardDraft'].includes(context.action)
  ) {
    try {
      const before: any = await strapi.documents(context.uid as any).findOne({
        documentId: context.params.documentId,
        fields: ['contentStatus'] as any,
      });
      offerWasPublished = before?.contentStatus === 'published';
    } catch {
      offerWasPublished = false;
    }
  }

  let preScope = null;
  if (
    ['delete', 'update', 'publish', 'unpublish', 'discardDraft'].includes(
      context.action,
    )
  ) {
    try {
      preScope = await preDeleteScope(
        strapi,
        context.uid,
        context.params?.documentId,
        context.action,
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
      entityIdentityBefore = await strapi.documents(context.uid as any).findOne({
        documentId: context.params.documentId,
        fields: ['name', 'slug'] as any,
      });
    } catch {
      entityIdentityBefore = null;
    }
  }

  let festiveOfferBefore = null;
  if (
    context.action === 'update' &&
    FESTIVE_OFFER_ENTITY_UIDS.has(context.uid) &&
    context.params?.documentId
  ) {
    try {
      festiveOfferBefore = await strapi.documents(context.uid as any).findOne({
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

  let entityOfferSweep = false;
  let entityOffersBefore = EMPTY_ENTITY_OFFER_SNAPSHOT;
  const merchantReferencedOffers: WriteSnapshot['merchantReferencedOffers'] =
    [];
  if (
    isAffiliateEntityUid(context.uid) &&
    ['create', 'update', 'clone', 'delete'].includes(context.action) &&
    (touchesEntityOfferRelations(context.params?.data) ||
      // A clone inherits the source's offer connections and a delete severs
      // every one of them (join rows cascade away, merchants are nulled) —
      // both rewire offers without the payload naming any.
      context.action === 'clone' ||
      context.action === 'delete')
  ) {
    entityOfferSweep = true;
    if (
      ['update', 'delete'].includes(context.action) &&
      context.params?.documentId
    ) {
      try {
        entityOffersBefore = await snapshotEntityOfferRelations(
          strapi,
          context.uid,
          context.params.documentId,
        );
      } catch {
        entityOffersBefore = null as any;
      }
    }
    if (context.action === 'delete' && context.params?.documentId) {
      const merchantValue = formatCheckoutMerchant({
        kind: context.uid === 'api::store.store' ? 'store' : 'brand',
        documentId: context.params.documentId,
      });
      for (const offerUid of OFFER_STORE_UIDS) {
        try {
          const rows: any[] = await strapi.db.query(offerUid).findMany({
            where: { [CHECKOUT_MERCHANT_FIELD]: merchantValue },
            select: ['documentId'],
          });
          for (const row of rows) {
            if (typeof row?.documentId === 'string') {
              merchantReferencedOffers.push({
                uid: offerUid,
                documentId: row.documentId,
              });
            }
          }
        } catch {
          // Unknown reference set → the invalidation builder fails toward
          // the full sweep via the null baseline below.
          entityOffersBefore = null as any;
        }
      }
    }
  }

  let brandAffiliateBefore: boolean | null = null;
  if (
    context.uid === 'api::brand.brand' &&
    context.action === 'update' &&
    context.params?.documentId
  ) {
    try {
      const before: any = await strapi.documents('api::brand.brand').findOne({
        documentId: context.params.documentId,
        fields: ['isAffiliate'] as any,
      });
      brandAffiliateBefore = before?.isAffiliate === true;
    } catch {
      brandAffiliateBefore = null;
    }
  }

  return {
    redirectBefore,
    offerWasPublished,
    preScope,
    entityIdentityBefore,
    festiveOfferBefore,
    entityOfferSweep,
    entityOffersBefore,
    merchantReferencedOffers,
    brandAffiliateBefore,
  };
}
