import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { useField } from '@strapi/strapi/admin';
import { Field, Flex, TextInput } from '@strapi/design-system';
import * as React from 'react';

import {
  BENEFIT_TEXT_FIELDS,
  benefitFieldHint,
  isBenefitAmount,
  normalizeBenefitAmount,
} from '../../utils/offer-word-limits';
import { isOfferModel } from '../utils/offer-status-filter';

/**
 * "Offer benefits" side panel for Coupon and Product Deal — the three stacking
 * benefit amounts (cashback, bank offer, prepaid) gathered under one heading
 * instead of scattered through the main form.
 *
 * The three fields are hidden from the main edit layout (see
 * HIDE_FROM_EDIT_FORM_ONLY in src/index.ts) and edited only here, the same way
 * PublishingPanel owns the lifecycle fields. Writes go through the shared form
 * state via useField, so nothing persists until the editor hits Save — and
 * Cancel still discards.
 *
 * Editors enter ONLY the amount ("10%" or "₹100"); the public API appends the
 * wording ("Cashback" / "Bank OFF" / "Prepaid OFF") on the way out. Labels and
 * hints derive from BENEFIT_TEXT_FIELDS — the same table the write validator
 * enforces — so the format shown can never drift from the rule.
 * Field.Error must render here: the amount-format ValidationError maps
 * details.errors[].path onto form errors, and with the fields gone from the
 * main form this panel is where that inline error surfaces.
 */

const BENEFIT_INPUTS = BENEFIT_TEXT_FIELDS.map(({ field, label, suffix }) => ({
  name: field,
  label,
  hint: benefitFieldHint(suffix),
}));

function BenefitTextInput({
  name,
  label,
  hint,
}: {
  name: string;
  label: string;
  hint?: string;
}) {
  const field = useField<string>(name);
  // Typing is unrestricted; the value is checked when the editor leaves the
  // field — flagging "1" as invalid mid-keystroke would be noise.
  const [blurred, setBlurred] = React.useState(false);

  const value = field.value ?? '';
  const draftError =
    blurred && value.trim() && !isBenefitAmount(value)
      ? 'Amount only — e.g. 10% or ₹100.'
      : undefined;

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    field.onChange(name, event.target.value);
  };

  const handleBlur = () => {
    setBlurred(true);
    // Canonicalize an accepted amount so the stored value is uniform:
    // "Rs. 2,000" → "₹2000", "10 %" → "10%".
    if (value.trim() && isBenefitAmount(value)) {
      const canonical = normalizeBenefitAmount(value);
      if (canonical !== value) field.onChange(name, canonical);
    }
  };

  return (
    <Field.Root error={field.error ?? draftError} name={name} hint={hint}>
      <Field.Label>{label}</Field.Label>
      <TextInput
        placeholder="10% or ₹100"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
      />
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
}

function OfferBenefitsPanelBody() {
  return (
    <Flex direction="column" alignItems="stretch" gap={4} width="100%">
      {BENEFIT_INPUTS.map(({ name, label, hint }) => (
        <BenefitTextInput key={name} name={name} label={label} hint={hint} />
      ))}
    </Flex>
  );
}

const OfferBenefitsPanel: PanelComponent = ({ model }) => {
  if (!isOfferModel(model)) return null;

  return {
    title: 'Offer benefits',
    content: <OfferBenefitsPanelBody />,
  };
};

export default OfferBenefitsPanel;
