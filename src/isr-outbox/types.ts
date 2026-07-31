export interface ScopeRequest {
  full?: boolean;
  homepage?: boolean;
  /** Refresh route-derived responses such as sitemap and route inventory. */
  sitemap?: boolean;
  slugs?: string[];
  /**
   * Conditionally generated routes that should be invalidated when admitted,
   * but whose authoritative absence is successful convergence.
   */
  optionalSlugs?: string[];
  refreshScopes?: string[];
}

export type OfferEntityType = 'coupon' | 'deal';

export interface OfferInvalidation {
  entityType: OfferEntityType;
  documentId: string;
}

export interface IsrOutboxPayload {
  all?: true;
  paths?: string[];
  /** A normalized subset of paths whose absence must not fail delivery. */
  optionalPaths?: string[];
  scopes?: string[];
  offerInvalidations?: OfferInvalidation[];
}

export interface IsrOutboxEvent {
  id: string;
  eventKey: string;
  lockToken: string;
  payload: IsrOutboxPayload;
  reason: string;
  attemptCount: number;
}

export interface IsrOutboxInsert {
  payload: IsrOutboxPayload;
  reason: string;
  eventKey?: string;
}
