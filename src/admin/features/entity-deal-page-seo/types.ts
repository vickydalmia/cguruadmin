import type { IdentityKind } from '../../../utils/route-normalization';

export type EntityDealPageBlocker =
  | 'indexing-disabled'
  | 'no-live-deals'
  | 'canonical-not-self'
  | 'route-conflict';

export type IndexState = 'disabled' | 'enabled' | 'blocked';

/** The SEO overrides an editor can author. Every one of them is optional. */
export type EntityDealPageSeoInput = {
  id?: number;
  indexingEnabled?: boolean | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: unknown;
  ogImageAlt?: string | null;
};

/**
 * What the backend actually serves after applying fallbacks. Never show only
 * the authored values: an empty metaTitle still renders "<Name> Deals &
 * Offers", and the screen must reflect the page as it will be published.
 */
export type ResolvedSeo = {
  metaTitle: string;
  metaDescription: string;
  canonical: string;
  indexingEnabled: boolean;
  effectiveIndexable: boolean;
  noIndex: boolean;
  blockers: EntityDealPageBlocker[];
  ogTitle: string;
  ogDescription: string;
  ogImageAlt: string;
};

export type EntityDealPageRow = {
  entityType: IdentityKind;
  documentId: string;
  id?: number;
  name: string;
  sourceSlug: string;
  publicSlug: string;
  entityPath: string;
  permalink: string;
  liveDealCount: number;
  updatedAt?: string;
  entityDealPageSeo: EntityDealPageSeoInput | null;
  resolvedSeo: ResolvedSeo;
  indexState: IndexState;
};

export type EntityDealPageListResponse = {
  data: EntityDealPageRow[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      pageCount: number;
    };
  };
};

export const ENTITY_KINDS: readonly IdentityKind[] = [
  'store',
  'brand',
  'category',
  'bank',
] as const;

export const INDEX_STATES: readonly IndexState[] = [
  'enabled',
  'disabled',
  'blocked',
] as const;

// Phrased as what the editor must DO, not as what the backend computed.
// "no-live-deals" is not an error the editor can fix by editing SEO.
export const BLOCKER_LABELS: Record<EntityDealPageBlocker, string> = {
  'indexing-disabled': 'Indexing is off for this page',
  'no-live-deals': 'No live Product Deals to show',
  'canonical-not-self': 'Canonical points at a different URL',
  'route-conflict': 'Another entity or redirect owns this URL',
};

export const INDEX_STATE_LABELS: Record<IndexState, string> = {
  enabled: 'Indexed',
  disabled: 'Off',
  blocked: 'Blocked',
};
