import * as React from 'react';
import {
  Field,
  MultiSelect,
  MultiSelectOption,
  Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

import type { OfferCountryOption } from '../../../../constants/offer-countries';
import {
  fetchEnabledOfferCountries,
  parseOfferCountriesValue,
  serializeOfferCountriesValue,
} from '../api/offer-country-options';

/**
 * The Offer Countries multi-select: the countries/regions this one offer is
 * valid in, from the subset enabled in Country Setup. Registered as a Strapi
 * custom field (src/constants/offer-countries.ts for why), so it renders in
 * the main edit form and stores a plain csv string.
 *
 * Props arrive from the content-manager's InputRenderer exactly like the
 * checkout-merchant input: `onChange(name, value)` is the form's write path.
 */

type OfferCountriesInputProps = {
  name: string;
  value?: string | null;
  error?: string;
  onChange: (name: string, value: string | null) => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  labelAction?: React.ReactNode;
  placeholder?: string;
};

type OptionsLoad =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; options: OfferCountryOption[] };

const OfferCountriesInput = React.forwardRef<
  HTMLDivElement,
  OfferCountriesInputProps
>(function OfferCountriesInput(props, forwardedRef) {
  const {
    name,
    value,
    error,
    onChange,
    label,
    hint,
    required,
    disabled,
    labelAction,
    placeholder,
  } = props;

  const { get } = useFetchClient();
  const [load, setLoad] = React.useState<OptionsLoad>({ state: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    fetchEnabledOfferCountries({ get })
      .then((options) => {
        if (!cancelled) setLoad({ state: 'ready', options });
      })
      .catch((caught) => {
        console.error('[offer-countries] failed to load options', caught);
        if (!cancelled) setLoad({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [get]);

  const selected = React.useMemo(() => parseOfferCountriesValue(value), [value]);
  const options = load.state === 'ready' ? load.options : [];
  const byCode = new Map(options.map((option) => [option.code, option]));
  // A stored code missing from the enabled list (country disabled after
  // tagging) must still render as a removable tag, not silently vanish from
  // the closed control while remaining in the saved value.
  const strandedCodes = selected.filter((code) => !byCode.has(code));

  // The feature is off (Country Setup csv empty) — say so instead of
  // rendering an empty dropdown that reads as a data problem.
  if (load.state === 'ready' && options.length === 0 && selected.length === 0) {
    return (
      <Field.Root name={name} id={name} hint={hint} required={required}>
        <Field.Label action={labelAction}>{label}</Field.Label>
        <Typography variant="pi" textColor="neutral600" tag="p">
          No offer countries are enabled for this site. A Super Admin can add
          them under Settings → Country Setup.
        </Typography>
        <Field.Hint />
      </Field.Root>
    );
  }

  return (
    <Field.Root name={name} id={name} error={error} hint={hint} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <div ref={forwardedRef}>
        <MultiSelect
          withTags
          value={selected}
          disabled={disabled || load.state !== 'ready'}
          loading={load.state === 'loading'}
          placeholder={
            load.state === 'loading'
              ? 'Loading countries…'
              : (placeholder ?? 'All countries (no restriction)')
          }
          onChange={(codes: string[]) =>
            onChange(name, serializeOfferCountriesValue(codes))
          }
          onClear={() => onChange(name, null)}
          clearLabel="Clear countries"
        >
          {options.map((option) => (
            <MultiSelectOption key={option.code} value={option.code}>
              {`${option.name} (${option.displayCode})`}
            </MultiSelectOption>
          ))}
          {strandedCodes.map((code) => (
            <MultiSelectOption key={code} value={code}>
              {`${code} — no longer enabled in Country Setup`}
            </MultiSelectOption>
          ))}
        </MultiSelect>
      </div>
      {load.state === 'error' ? (
        <Typography variant="pi" textColor="danger600" tag="p">
          Could not load the country list — reload the page to try again.
        </Typography>
      ) : null}
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
});

export default OfferCountriesInput;
