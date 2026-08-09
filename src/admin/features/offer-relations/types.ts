import type { CheckoutMerchantRef } from '../../../constants/checkout-merchant';
import type { BrandRef } from '../../utils/affiliate-state';

export type RelationConfig = {
  field: string;
  target: string;
  label: string;
  mainField?: 'name' | 'title';
  scopeRelationField?: 'stores' | 'brands' | 'categories' | 'banks';
  minSelections?: number;
  maxSelections?: number;
  description?: string;
  reorderable?: boolean;
  affiliateRule?: 'stores' | 'brands';
};

export type AffiliateContext = {
  storeCount: number;
  storesReady: boolean;
  brandsReady: boolean;
  affiliateFlagsReady: boolean;
  /**
   * Deduplicated {documentId, name} PAIRS — the single source the id set and
   * name list below are derived from, so the two can never fall out of
   * alignment.
   */
  affiliateSelectedRefs: ReadonlyArray<BrandRef>;
  affiliateSelectedDocIds: ReadonlySet<string>;
  affiliateSelectedNames: readonly string[];
  merchant: CheckoutMerchantRef | null;
};

/**
 * A section's resolved persisted+diff selection, reported up so the two
 * affiliate-rule sections can know about each other. The form value alone
 * cannot provide this: it is a connect/disconnect DIFF over a baseline that
 * lives in the section's own state.
 */
export type SelectionReport = {
  entries: Array<{ documentId: string; name: string; isAffiliate?: boolean }>;
  ready: boolean;
};
