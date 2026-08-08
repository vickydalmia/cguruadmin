import type { CheckoutMerchantRef } from '../../constants/checkout-merchant';

/**
 * Pure blocking rules for the affiliate-brand exclusivity contract in the
 * Taxonomies panel: an affiliate brand is an offer's ONLY merchant — no
 * Store, no other brands, no checkout merchant pointing elsewhere.
 *
 * Same house rules as coupon-layout's candidateDisabled: a row that is
 * ALREADY selected is never disabled (deselection is the escape hatch on
 * legacy conflicts), and unknown state — sibling section still loading, the
 * affiliate-flag lookup unresolved — fails toward blocking the ADD, never
 * toward allowing an invalid one. The server validator
 * (utils/affiliate-brand-validation.ts) stays the guarantee; these rules are
 * the UX in front of it.
 */

/** Should this affiliate-brand candidate row refuse a tick? */
export function affiliateCandidateBlocked(args: {
  isSelected: boolean;
  /** Resolved Store selection of the sibling stores section. */
  storeCount: number;
  storesReady: boolean;
  /** How many brands are selected (this candidate is not among them). */
  selectedBrandCount: number;
  /**
   * The brands section's OWN persisted-selection readiness. While it is still
   * loading, `selectedBrandCount` under-reports (another brand may already be
   * ticked on the stored row) — unknown blocks the add.
   */
  brandsReady: boolean;
  merchant: CheckoutMerchantRef | null;
  candidateDocumentId: string;
}): boolean {
  if (args.isSelected) return false;
  if (!args.storesReady || !args.brandsReady) return true;
  if (args.storeCount > 0) return true;
  if (args.selectedBrandCount > 0) return true;
  if (
    args.merchant &&
    !(
      args.merchant.kind === 'brand' &&
      args.merchant.documentId === args.candidateDocumentId
    )
  ) {
    return true;
  }
  return false;
}

/** Should this NON-affiliate brand candidate row refuse a tick? */
export function plainCandidateBlocked(args: {
  isSelected: boolean;
  brandsReady: boolean;
  affiliateFlagsReady: boolean;
  affiliateSelectedCount: number;
}): boolean {
  if (args.isSelected) return false;
  if (args.affiliateSelectedCount > 0) return true;
  // Unknown brand state blocks UNCONDITIONALLY — before the section's first
  // report the count reads 0 while the stored row may hold an affiliate
  // brand, so gating this on `selectedBrandCount > 0` would open exactly the
  // window the fail-safe exists to close.
  if (!args.brandsReady || !args.affiliateFlagsReady) return true;
  return false;
}

/**
 * Route a Brand candidate through the correct exclusivity rule.
 *
 * `isAffiliate` can be absent when Content Manager omits the field (for
 * example because the editor cannot read it). Only explicit booleans are
 * actionable: an unresolved candidate fails safe instead of being treated as
 * a plain Brand. An already-selected row remains removable regardless.
 */
export function brandCandidateBlocked(args: {
  isSelected: boolean;
  isAffiliate: boolean | null | undefined;
  storeCount: number;
  storesReady: boolean;
  selectedBrandCount: number;
  brandsReady: boolean;
  affiliateFlagsReady: boolean;
  affiliateSelectedCount: number;
  merchant: CheckoutMerchantRef | null;
  candidateDocumentId: string;
}): boolean {
  if (args.isSelected) return false;

  if (args.isAffiliate === true) {
    return affiliateCandidateBlocked({
      isSelected: false,
      storeCount: args.storeCount,
      storesReady: args.storesReady,
      selectedBrandCount: args.selectedBrandCount,
      brandsReady: args.brandsReady,
      merchant: args.merchant,
      candidateDocumentId: args.candidateDocumentId,
    });
  }

  if (args.isAffiliate === false) {
    return plainCandidateBlocked({
      isSelected: false,
      brandsReady: args.brandsReady,
      affiliateFlagsReady: args.affiliateFlagsReady,
      affiliateSelectedCount: args.affiliateSelectedCount,
    });
  }

  return true;
}

/**
 * Should picking (or switching) a Store be refused? Removal of an existing
 * Store is never routed through this — it stays available on legacy
 * conflicts. The identical rule guards the checkout-merchant dropdown.
 */
export function storeAddBlocked(args: {
  brandsReady: boolean;
  affiliateFlagsReady: boolean;
  affiliateSelectedCount: number;
}): boolean {
  if (args.affiliateSelectedCount > 0) return true;
  // Same unconditional unknown-blocks rule as plainCandidateBlocked: before
  // the brands section reports, a persisted affiliate brand is invisible and
  // the count-gated check would let a Store (or checkout merchant) in.
  if (!args.brandsReady || !args.affiliateFlagsReady) return true;
  return false;
}

const joinNames = (names: readonly string[]): string => names.join(', ');

/** Note under the Brands section explaining why affiliate rows are greyed. */
export function affiliateBlockNote(args: {
  storeCount: number;
  selectedBrandCount: number;
  affiliateSelectedNames: readonly string[];
}): string | null {
  if (args.affiliateSelectedNames.length > 0) {
    return (
      `Affiliate brand ${joinNames(args.affiliateSelectedNames)} must be ` +
      'the only merchant on this offer — remove it to select other brands ' +
      'or a Store.'
    );
  }
  if (args.storeCount > 0) {
    return 'Affiliate brands are disabled while a Store is selected.';
  }
  if (args.selectedBrandCount > 0) {
    return 'Affiliate brands are disabled while other brands are selected.';
  }
  return null;
}

/** Warning above the Store radios while an affiliate brand blocks them. */
export function storeBlockNote(args: {
  affiliateSelectedNames: readonly string[];
}): string | null {
  if (args.affiliateSelectedNames.length === 0) return null;
  return (
    `Store selection is disabled: affiliate brand ` +
    `${joinNames(args.affiliateSelectedNames)} is this offer's merchant. ` +
    'Remove it to pick a Store.'
  );
}
