import { BRAND_AFFILIATE_FLAG_FIELD } from '../../../constants/affiliate-offer';

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
};

export const RELATION_CONFIG: Record<string, RelationConfig[]> = {
  'api::deal.deal': [
    {
      field: 'stores',
      target: 'api::store.store',
      label: 'Store',
      minSelections: 0,
      maxSelections: 1,
    },
    { field: 'brands', target: 'api::brand.brand', label: 'Brands' },
    { field: 'categories', target: 'api::category.category', label: 'Categories' },
    { field: 'banks', target: 'api::bank.bank', label: 'Banks' },
  ],
  'api::coupon.coupon': [
    {
      field: 'stores',
      target: 'api::store.store',
      label: 'Store',
      minSelections: 0,
      maxSelections: 1,
    },
    { field: 'brands', target: 'api::brand.brand', label: 'Brands' },
    { field: 'categories', target: 'api::category.category', label: 'Categories' },
    { field: 'banks', target: 'api::bank.bank', label: 'Banks' },
  ],
};

export const PAGE_SIZE = 30;

// Only brands flagged "Affiliate Store" are listed while the affiliate toggle
// is ON. `$eq: true` correctly excludes legacy NULL rows (no DB default).
// Module-level for reference stability across renders.
export const AFFILIATE_BRAND_CANDIDATE_FILTER: Readonly<Record<string, string>> = {
  [`filters[${BRAND_AFFILIATE_FLAG_FIELD}][$eq]`]: 'true',
};

export type SelectedRelationState = { count: number; ready: boolean };
