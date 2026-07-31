import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { useField } from '@strapi/strapi/admin';
import {
  Field,
  Flex,
  SingleSelect,
  SingleSelectOption,
  TextInput,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';

import {
  BENEFIT_TEXT_FIELDS,
  benefitFieldHint,
  isOfferAmount,
  normalizeOfferAmount,
  offerAmountFieldHint,
} from '../../utils/offer-word-limits';
import {
  DEAL_DISCOUNT_PREFIXES,
  formatDealDiscount,
} from '../../utils/deal-discount';
import { isOfferModel } from '../utils/offer-status-filter';

/**
 * Promotion side panel for Coupon and Product Deal. The three stacking benefit
 * amounts (cashback, bank offer, prepaid) are gathered under one heading, and
 * Product Deals additionally get the paired discount prefix/amount controls.
 *
 * These fields are hidden from the main edit layout (see
 * HIDE_FROM_EDIT_FORM_ONLY in src/index.ts) and edited only here, the same way
 * PublishingPanel owns the lifecycle fields. Writes go through the shared form
 * state via useField, so nothing persists until the editor hits Save — and
 * Cancel still discards.
 *
 * Editors enter ONLY the amount ("10%", "₹100" or "$40"); the public API
 * appends the controlled Deal/benefit wording on the way out. Labels and hints
 * derive from the same browser-safe tables the write validator enforces, so
 * the format shown can never drift from the rule.
 * Field.Error must render here: the amount-format ValidationError maps
 * details.errors[].path onto form errors, and with the fields gone from the
 * main form this panel is where that inline error surfaces.
 */

const BENEFIT_INPUTS = BENEFIT_TEXT_FIELDS.map(({ field, label, suffix }) => ({
  name: field,
  label,
  hint: benefitFieldHint(suffix),
}));

function OfferAmountInput({
  name,
  label,
  hint,
  placeholder = '10% or ₹100',
}: {
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
}) {
  const field = useField<string>(name);
  // Typing is unrestricted; the value is checked when the editor leaves the
  // field — flagging "1" as invalid mid-keystroke would be noise.
  const [blurred, setBlurred] = React.useState(false);

  const value = field.value ?? '';
  const draftError =
    blurred && value.trim() && !isOfferAmount(value)
      ? 'Amount only — e.g. 10%, ₹100 or $40.'
      : undefined;

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    field.onChange(name, event.target.value);
  };

  const handleBlur = () => {
    setBlurred(true);
    // Canonicalize an accepted amount so the stored value is uniform:
    // "Rs. 2,000" → "₹2000", "10 %" → "10%".
    if (value.trim() && isOfferAmount(value)) {
      const canonical = normalizeOfferAmount(value);
      if (canonical !== value) field.onChange(name, canonical);
    }
  };

  return (
    <Field.Root error={field.error ?? draftError} name={name} hint={hint}>
      <Field.Label>{label}</Field.Label>
      <TextInput
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
      />
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
}

function DealDiscountFields() {
  const prefixField = useField<string | null>('discountPrefix');
  const discountField = useField<string>('discount');
  const preview = formatDealDiscount(discountField.value, prefixField.value);
  const hasStandardPreview = Boolean(
    prefixField.value && discountField.value && isOfferAmount(discountField.value),
  );

  return (
    <Flex direction="column" alignItems="stretch" gap={4} width="100%">
      <Field.Root
        error={prefixField.error}
        name="discountPrefix"
        hint="Choose the controlled wording shown before the discount amount."
      >
        <Field.Label>Discount prefix</Field.Label>
        <SingleSelect
          placeholder="Select a prefix"
          value={prefixField.value || undefined}
          onClear={() => prefixField.onChange('discountPrefix', null)}
          onChange={(value: string | number) =>
            prefixField.onChange('discountPrefix', String(value))
          }
        >
          {DEAL_DISCOUNT_PREFIXES.map(({ value, label }) => (
            <SingleSelectOption key={value} value={value}>
              {label}
            </SingleSelectOption>
          ))}
        </SingleSelect>
        <Field.Hint />
        <Field.Error />
      </Field.Root>

      <OfferAmountInput
        name="discount"
        label="Discount amount"
        hint={offerAmountFieldHint('the selected prefix and OFF')}
      />

      {hasStandardPreview ? (
        <Typography variant="pi" textColor="neutral600">
          Site label preview: {preview}
        </Typography>
      ) : null}
    </Flex>
  );
}

function OfferBenefitsPanelBody({ includeDiscount }: { includeDiscount: boolean }) {
  return (
    <Flex direction="column" alignItems="stretch" gap={4} width="100%">
      {includeDiscount ? <DealDiscountFields /> : null}
      {BENEFIT_INPUTS.map(({ name, label, hint }) => (
        <OfferAmountInput key={name} name={name} label={label} hint={hint} />
      ))}
    </Flex>
  );
}

const OfferBenefitsPanel: PanelComponent = ({ model }) => {
  if (!isOfferModel(model)) return null;
  const includeDiscount = model === 'api::deal.deal';

  return {
    title: includeDiscount ? 'Deal discount & benefits' : 'Offer benefits',
    content: <OfferBenefitsPanelBody includeDiscount={includeDiscount} />,
  };
};

export default OfferBenefitsPanel;
