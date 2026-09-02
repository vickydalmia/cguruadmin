import * as React from 'react';
import {
  Badge,
  Box,
  Button,
  Field,
  Flex,
  MultiSelect,
  MultiSelectOption,
  Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

import {
  countrySetupError,
  parseOfferCountries,
  serializeOfferCountries,
  unwrapOfferCountries,
} from '../api';
import type { SelectableOfferCountry } from '../types';

type Props = {
  /** The stored csv (`offerCountries`). */
  value: string;
  onChange: (csv: string) => void;
};

type CountryLoad =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; countries: SelectableOfferCountry[] };

function useSelectableOfferCountries(): [CountryLoad, () => void] {
  const { get } = useFetchClient();
  const [load, setLoad] = React.useState<CountryLoad>({ state: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoad({ state: 'loading' });
    get('/country-setup/offer-countries')
      .then((response) => {
        if (!cancelled) {
          setLoad({ state: 'ready', countries: unwrapOfferCountries(response) });
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setLoad({ state: 'error', message: countrySetupError(caught) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [get, attempt]);

  return [load, () => setAttempt((count) => count + 1)];
}

export function OfferCountriesField({ value, onChange }: Props) {
  const [load, retry] = useSelectableOfferCountries();
  const selected = parseOfferCountries(value);
  const countries = load.state === 'ready' ? load.countries : [];
  const byCode = new Map(countries.map((country) => [country.code, country]));
  const loading = load.state === 'loading';
  const errorMessage = load.state === 'error' ? load.message : undefined;

  return (
    <Field.Root
      name="offerCountries"
      hint={
        'Countries and regions editors can tag Coupons and Product Deals with. ' +
        'Tagged offers show flag badges and power the entity-page Country ' +
        'filter; leave empty to keep the whole feature off. Untagged offers ' +
        'are always treated as valid everywhere.'
      }
      error={errorMessage}
    >
      <Field.Label>Offer countries</Field.Label>
      <MultiSelect
        withTags
        value={selected}
        disabled={loading || load.state === 'error'}
        loading={loading}
        placeholder={loading ? 'Loading countries…' : 'Pick countries and regions'}
        onChange={(codes: string[]) => onChange(serializeOfferCountries(codes))}
        onClear={() => onChange('')}
        clearLabel="Clear countries"
      >
        {countries.map((country) => (
          <MultiSelectOption key={country.code} value={country.code}>
            {`${country.name} (${country.displayCode})`}
          </MultiSelectOption>
        ))}
      </MultiSelect>
      <Field.Hint />
      <Field.Error />
      {load.state === 'error' ? (
        <Box paddingTop={2}>
          <Button variant="tertiary" size="S" onClick={retry}>
            Retry loading countries
          </Button>
        </Box>
      ) : null}
      {load.state === 'ready' && selected.length > 0 ? (
        <Flex paddingTop={3} gap={2} wrap="wrap">
          {selected.map((code) => {
            const country = byCode.get(code);
            return (
              <Badge key={code} active={country?.kind === 'region'}>
                {country
                  ? `${country.displayCode} · ${country.name}`
                  : `${code} — not selectable; saving will reject it`}
              </Badge>
            );
          })}
        </Flex>
      ) : null}
    </Field.Root>
  );
}
