import { Box } from '@strapi/design-system';

import { AFFILIATE_OFFER_TOGGLE_FIELD } from '../../../../constants/affiliate-offer';
import BooleanConfirmInput from '../../../components/BooleanConfirmInput';
import { type SelectedRelationState } from '../config';

/**
 * The `isForAffiliateBrand` toggle, rendered at the top of the Taxonomies
 * panel next to the pickers it gates (the field is hidden from the main edit
 * form via OFFER_PANEL_ONLY_FIELDS in src/bootstrap/content-manager-layouts.ts).
 * Reuses BooleanConfirmInput
 * so it keeps the same confirm-on-flip behaviour as every other boolean.
 *
 * Enable gate: turning OFF is always allowed; turning ON requires zero Stores
 * AND zero Brands currently selected (live form state). An unknown baseline
 * (selected relations still loading) counts as blocked — it must not enable
 * the gate.
 */
export function AffiliateOfferToggle({
  isOn,
  selectionState,
}: {
  isOn: boolean;
  selectionState: Record<string, SelectedRelationState>;
}) {
  const storesState = selectionState.stores;
  const brandsState = selectionState.brands;
  const selectionsPending = !storesState?.ready || !brandsState?.ready;
  const hasSelections =
    (storesState?.count ?? 0) > 0 || (brandsState?.count ?? 0) > 0;
  const disabled = !isOn && (selectionsPending || hasSelections);

  const hint = isOn
    ? 'Stores are disabled and only affiliate Brands are listed. Logo Store ' +
      'and Checkout merchant are hidden and cleared on save.'
    : hasSelections
      ? 'Untick all Stores and Brands first to enable this.'
      : selectionsPending
        ? 'Checking current Store/Brand selections…'
        : 'Turns this into an affiliate-brand offer: affiliate Brands only, ' +
          'no Stores, no Logo Store, no Checkout merchant.';

  return (
    <Box paddingTop={3} paddingBottom={3} width="100%">
      <BooleanConfirmInput
        name={AFFILIATE_OFFER_TOGGLE_FIELD}
        label="Affiliate brand offer"
        hint={hint}
        disabled={disabled}
      />
    </Box>
  );
}
