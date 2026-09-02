import * as React from 'react';
import {
  Badge,
  Box,
  Button,
  Field,
  Flex,
  Grid,
  TextInput,
  Toggle,
  Typography,
} from '@strapi/design-system';
import {
  Layouts,
  Page,
  useFetchClient,
  useNotification,
} from '@strapi/strapi/admin';

import {
  countrySetupError,
  countrySetupPayload,
  unwrapCountrySetup,
} from '../api';
import {
  FEATURE_FORM_DEFINITIONS,
  type CountrySetup,
} from '../types';
import { OfferCountriesField } from './offer-countries-field';
import { TranslationLanguagesField } from './translation-languages-field';

const IDENTITY_FIELDS = [
  ['siteName', 'Site / brand name', 'CouponzGuru'],
  ['countryName', 'Country name', 'United States'],
  ['countryCode', 'ISO country code', 'US'],
  ['locale', 'Locale', 'en-US'],
  ['timezone', 'IANA timezone', 'America/New_York'],
  ['currencyCode', 'ISO currency code', 'USD'],
] as const;

function localizationPreview(form: CountrySetup) {
  try {
    const locale = String(form.locale || 'en-US');
    const currencyCode = String(form.currencyCode || 'USD').toUpperCase();
    const timezone = String(form.timezone || 'UTC');
    const currency = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 0,
    });
    const number = new Intl.NumberFormat(locale);
    const date = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone: timezone,
    });
    return {
      currencyCode,
      currencySymbol:
        currency.formatToParts(0).find((part) => part.type === 'currency')
          ?.value ?? currencyCode,
      numberExample: number.format(1234567.89),
      dateExample: date.format(new Date(Date.UTC(2026, 0, 15, 12))),
    };
  } catch {
    return form.localization;
  }
}

function FieldInput({
  field,
  label,
  placeholder,
  value,
  onChange,
}: {
  field: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field.Root name={field}>
      <Field.Label>{label}</Field.Label>
      <TextInput
        value={value}
        placeholder={placeholder}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value)
        }
      />
    </Field.Root>
  );
}

export default function CountrySetupPage() {
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [form, setForm] = React.useState<CountrySetup | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setForm(unwrapCountrySetup(await get('/country-setup/')));
    } catch (caught) {
      setError(countrySetupError(caught));
    } finally {
      setLoading(false);
    }
  }, [get]);

  React.useEffect(() => void load(), [load]);

  const set = (field: string, value: unknown) =>
    setForm((current) => (current ? { ...current, [field]: value } : current));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const response = await put('/country-setup/', {
        data: countrySetupPayload(form),
      });
      setForm(unwrapCountrySetup(response));
      toggleNotification({ type: 'success', message: 'Country Setup saved.' });
    } catch (caught) {
      toggleNotification({ type: 'danger', message: countrySetupError(caught) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Page.Loading />;
  if (error || !form) {
    return (
      <Page.Main>
        <Page.Title>Country Setup</Page.Title>
        <Page.Error content={error ?? 'Country Setup is unavailable.'} />
      </Page.Main>
    );
  }

  const preview = localizationPreview(form);

  return (
    <Page.Main>
      <Page.Title>Country Setup</Page.Title>
      <Layouts.Root>
        <Layouts.Header
          title="Country Setup"
          subtitle="Identity, localization, website availability and Content Manager visibility"
          primaryAction={<Button loading={saving} onClick={save}>Save</Button>}
        />
        <Layouts.Content>
          <Flex direction="column" alignItems="stretch" gap={6}>
            <Box padding={5} background="primary100" hasRadius>
              <Typography textColor="primary700">
                Features that are Off are removed from the Content Manager menu
                and from the public website. Turn a feature On and save to make
                it available for editing. It remains hidden from the public
                website until its required content is Ready.
              </Typography>
            </Box>
            <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
              <Typography variant="beta">Identity and localization</Typography>
              <Box paddingTop={5}>
                <Grid.Root gap={5}>
                  {IDENTITY_FIELDS.map(([field, label, placeholder]) => (
                    <Grid.Item key={field} col={6} s={12} xs={12}>
                      <FieldInput
                        field={field}
                        label={label}
                        placeholder={placeholder}
                        value={String(form[field] ?? '')}
                        onChange={(value) => set(field, value)}
                      />
                    </Grid.Item>
                  ))}
                </Grid.Root>
              </Box>
              <Box paddingTop={5}>
                <Field.Root name="onboardingComplete" hint="Mark complete after identity and every enabled feature have been reviewed.">
                  <Field.Label>Onboarding complete</Field.Label>
                  <Toggle
                    checked={form.onboardingComplete}
                    onLabel="Yes"
                    offLabel="No"
                    onChange={() => set('onboardingComplete', !form.onboardingComplete)}
                  />
                  <Field.Hint />
                </Field.Root>
              </Box>
            </Box>

            <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
              <Typography variant="beta">Localization preview</Typography>
              <Flex paddingTop={4} gap={3} wrap="wrap">
                <Badge>{`${preview.currencyCode} · ${preview.currencySymbol}`}</Badge>
                <Badge>{preview.numberExample}</Badge>
                <Badge>{preview.dateExample}</Badge>
              </Flex>
            </Box>

            <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
              <Typography variant="beta">AI content translation</Typography>
              <Box paddingTop={2}>
                <Typography variant="pi" textColor="neutral600">
                  Automatically writes a translated version of every localized
                  entry (stores, coupons, pages, …) whenever the English source
                  is saved, and serves it under its own URL prefix (e.g. /ar/).
                  Needs the TRANSLATION_* server environment configured. Saving
                  applies to this CMS instance immediately (locale rows, URL
                  twins, translator); other CMS containers pick the change up
                  when they restart.
                </Typography>
              </Box>
              <Flex paddingTop={4} gap={5} alignItems="flex-end" wrap="wrap">
                <Field.Root name="translationEnabled">
                  <Field.Label>Translation enabled</Field.Label>
                  <Toggle
                    checked={form.translationEnabled === true}
                    onLabel="On"
                    offLabel="Off"
                    onChange={() =>
                      set('translationEnabled', form.translationEnabled !== true)
                    }
                  />
                </Field.Root>
                <Box grow={1} minWidth="240px">
                  <TranslationLanguagesField
                    value={String(form.translationLocales ?? '')}
                    disabled={form.translationEnabled !== true}
                    onChange={(csv) => set('translationLocales', csv)}
                  />
                </Box>
              </Flex>
            </Box>

            <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
              <Typography variant="beta">Offer countries</Typography>
              <Box paddingTop={2}>
                <Typography variant="pi" textColor="neutral600">
                  Optional per-offer country tagging for multi-country markets
                  (e.g. the GCC). Editors pick from this list on each Coupon
                  and Product Deal; the website shows the flags on offer cards
                  and adds a Country filter on entity pages. Leave empty for a
                  single-country site.
                </Typography>
              </Box>
              <Box paddingTop={4}>
                <OfferCountriesField
                  value={String(form.offerCountries ?? '')}
                  onChange={(csv) => set('offerCountries', csv)}
                />
              </Box>
            </Box>

            {(['Catalog', 'Editorial', 'Legal'] as const).map((group) => (
              <Box key={group} padding={6} background="neutral0" shadow="filterShadow" hasRadius>
                <Typography variant="beta">{group}</Typography>
                <Flex paddingTop={4} direction="column" alignItems="stretch" gap={4}>
                  {FEATURE_FORM_DEFINITIONS.filter((feature) => feature.group === group).map((feature) => {
                    const state = form.features[feature.key];
                    const checked = form[feature.field] === true;
                    return (
                      <Flex key={feature.key} justifyContent="space-between" alignItems="flex-start" gap={4}>
                        <Box>
                          <Typography fontWeight="bold">{feature.label}</Typography>
                          <Typography variant="pi" textColor="neutral600">
                            {feature.destinations.join(' · ')}
                          </Typography>
                          {state?.reason ? (
                            <Typography variant="pi" textColor={state.ready ? 'neutral600' : 'danger600'}>
                              {state.reason}
                            </Typography>
                          ) : null}
                        </Box>
                        <Flex gap={3}>
                          <Badge active={state?.ready}>
                            {state?.ready ? 'Ready' : 'Incomplete'}
                          </Badge>
                          <Toggle
                            checked={checked}
                            onLabel="On"
                            offLabel="Off"
                            onChange={() => set(feature.field, !checked)}
                          />
                        </Flex>
                      </Flex>
                    );
                  })}
                </Flex>
              </Box>
            ))}
          </Flex>
        </Layouts.Content>
      </Layouts.Root>
    </Page.Main>
  );
}
