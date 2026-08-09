import type { RelationConfig } from './types';

export const PAGE_SIZE = 30;

export const RELATION_CONFIG: Record<string, RelationConfig[]> = {
  'api::deal.deal': [
    {
      field: 'stores',
      target: 'api::store.store',
      label: 'Store',
      minSelections: 0,
      maxSelections: 1,
      affiliateRule: 'stores',
    },
    {
      field: 'brands',
      target: 'api::brand.brand',
      label: 'Brands',
      affiliateRule: 'brands',
    },
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
      affiliateRule: 'stores',
    },
    {
      field: 'brands',
      target: 'api::brand.brand',
      label: 'Brands',
      affiliateRule: 'brands',
    },
    { field: 'categories', target: 'api::category.category', label: 'Categories' },
    { field: 'banks', target: 'api::bank.bank', label: 'Banks' },
  ],
};
