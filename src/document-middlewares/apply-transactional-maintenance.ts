import type { Core } from '@strapi/strapi';

import { CHECKOUT_MERCHANT_FIELD } from '../constants/checkout-merchant';
import { removeInactiveCuratedOfferRelations } from '../utils/curated-offer-relations';
import { clearDeletedCheckoutMerchant } from '../utils/checkout-merchant-validation';
import {
  detachAffiliateBrand,
  touchesEntityOfferRelations,
  type AffiliateCascadeResult,
} from '../utils/affiliate-brand-validation';
import {
  changesEntityOfferMembership,
  touchEntityPageUpdatedAt,
} from '../utils/entity-page-timestamp';
import { fillHomepageOverrides } from '../utils/homepage-overrides';
import type {
  DocumentWriteContext,
  TransactionalMaintenance,
  WriteSnapshot,
} from './content-write-types';

export async function applyTransactionalMaintenance(
  strapi: Core.Strapi,
  context: DocumentWriteContext,
  result: unknown,
  trx: any,
  snapshot: WriteSnapshot,
): Promise<TransactionalMaintenance> {
  if (
    context.action === 'update' &&
    changesEntityOfferMembership(context.uid, context.params?.data)
  ) {
    await touchEntityPageUpdatedAt(
      strapi,
      trx,
      context.uid,
      result,
      context.params?.documentId,
    );
  }

  if (
    context.action === 'delete' &&
    context.params?.documentId &&
    (context.uid === 'api::store.store' || context.uid === 'api::brand.brand')
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
  let affiliateCascade: AffiliateCascadeResult | null = null;
  if (
    context.uid === 'api::brand.brand' &&
    ['create', 'update', 'clone'].includes(context.action) &&
    documentId
  ) {
    const resultAffiliate = (result as any)?.isAffiliate;
    let finalAffiliate = resultAffiliate === true;
    if (resultAffiliate === undefined) {
      const after: any = await strapi.documents('api::brand.brand').findOne({
        documentId,
        fields: ['isAffiliate'] as any,
      });
      finalAffiliate = after?.isAffiliate === true;
    }
    const touchesOfferRelations = touchesEntityOfferRelations(
      context.params?.data,
    );
    const flipped =
      context.action !== 'update' || snapshot.brandAffiliateBefore !== true;
    if (finalAffiliate && (flipped || touchesOfferRelations)) {
      affiliateCascade = await detachAffiliateBrand(strapi, trx, documentId);
      if (affiliateCascade.affected.length > 0) {
        strapi.log.info(
          `[affiliate-brand] brand ${documentId}: detached from ` +
            `${affiliateCascade.detachedCount} offer(s), cleared ` +
            `${affiliateCascade.merchantsClearedCount} checkout ` +
            `merchant(s)`,
        );
      }
    }
  }

  return {
    documentId,
    affiliateCascade,
    removeInactiveCuratedOffer: async () => {
      if (!snapshot.offerWasPublished || !documentId) return;
      try {
        const after: any = await strapi.documents(context.uid as any).findOne({
          documentId,
          fields: ['contentStatus'] as any,
        });
        if (after && after.contentStatus !== 'published') {
          await removeInactiveCuratedOfferRelations(strapi, new Date(), {
            [context.uid]: [documentId],
          } as any);
        }
      } catch (err: any) {
        strapi.log.warn(
          `[curated-offers] inline cleanup failed for ${context.uid} ${documentId}: ` +
            `${err?.message ?? err}`,
        );
      }
    },
  };
}
