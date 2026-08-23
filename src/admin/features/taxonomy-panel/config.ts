import { BRAND_AFFILIATE_FLAG_FIELD } from '../../../constants/affiliate-offer';
import {
  OFFER_TAXONOMY_UIDS,
  type OfferTaxonomyField,
} from '../../../constants/offer-taxonomy';

export type RelationConfig = {
  field: OfferTaxonomyField;
  target: string;
  /** Heading and search-placeholder noun; may be plural. */
  label: string;
  /** Singular noun used by generic single-choice guidance. */
  singularLabel: string;
  minSelections?: number;
  maxSelections?: number;
};

// One shared section list for every offer type: Coupon and Deal taxonomy
// panels enforce the same invariants against the same server-side validators,
// so a per-type copy would only invite accidental drift. The field names are
// typed against OFFER_TAXONOMY_FIELDS (the same constant HIDE_FROM_EDIT uses
// server-side), so renaming a relation without updating the shared constant
// fails to compile instead of silently losing the field.
const OFFER_TAXONOMY_SECTIONS: readonly RelationConfig[] = [
  {
    field: 'stores',
    target: 'api::store.store',
    label: 'Store',
    singularLabel: 'Store',
    minSelections: 0,
    maxSelections: 1,
  },
  {
    field: 'brands',
    target: 'api::brand.brand',
    label: 'Brands',
    singularLabel: 'Brand',
  },
  {
    field: 'categories',
    target: 'api::category.category',
    label: 'Categories',
    singularLabel: 'Category',
  },
  {
    field: 'banks',
    target: 'api::bank.bank',
    label: 'Banks',
    singularLabel: 'Bank',
  },
];

export const RELATION_CONFIG: Record<string, readonly RelationConfig[]> =
  Object.fromEntries(OFFER_TAXONOMY_UIDS.map((uid) => [uid, OFFER_TAXONOMY_SECTIONS]));

export const PAGE_SIZE = 30;

// Only brands flagged "Affiliate Store" are listed while the affiliate toggle
// is ON. `$eq: true` correctly excludes legacy NULL rows (no DB default).
// Module-level for reference stability across renders.
export const AFFILIATE_BRAND_CANDIDATE_FILTER: Readonly<Record<string, string>> = {
  [`filters[${BRAND_AFFILIATE_FLAG_FIELD}][$eq]`]: 'true',
};

export type SelectedRelationState = { count: number; ready: boolean };
