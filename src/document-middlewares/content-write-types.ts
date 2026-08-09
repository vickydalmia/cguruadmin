import type { ScopeRequest } from '../isr-outbox/types';
import type { FestiveOfferSnapshot } from '../isr-outbox/scopes';
import type {
  AffiliateCascadeResult,
  EntityOfferSnapshot,
} from '../utils/affiliate-brand-validation';

export type DocumentWriteContext = {
  uid: string;
  action: string;
  params?: {
    documentId?: string;
    data?: Record<string, any>;
  };
};

export type WriteSnapshot = {
  redirectBefore: Record<string, unknown> | null;
  offerWasPublished: boolean;
  preScope: ScopeRequest | null;
  entityIdentityBefore: { name?: unknown; slug?: unknown } | null;
  festiveOfferBefore: FestiveOfferSnapshot | null;
  entityOfferSweep: boolean;
  entityOffersBefore: EntityOfferSnapshot | null;
  /**
   * Offers whose checkoutMerchant POINTS at a Store/Brand being deleted —
   * clearDeletedCheckoutMerchant nulls them inside the delete transaction,
   * so their invalidation must be captured before the row disappears.
   */
  merchantReferencedOffers: Array<{
    uid: 'api::coupon.coupon' | 'api::deal.deal';
    documentId: string;
  }>;
  brandAffiliateBefore: boolean | null;
};

export type TransactionalMaintenance = {
  documentId?: string;
  affiliateCascade: AffiliateCascadeResult | null;
  removeInactiveCuratedOffer: () => Promise<void>;
};
