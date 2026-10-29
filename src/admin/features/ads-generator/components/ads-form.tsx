import * as React from 'react';
import {
  Button, Field, Flex, Grid, SingleSelect, SingleSelectOption, Textarea, TextInput, Typography,
} from '@strapi/design-system';
import type { AdsGeneratorFormInput, AdsGeneratorOptions } from '../../../../constants/ads-generator';

/**
 * The team form. Plain text fields for this iteration; the server parses and
 * validates everything (src/ads-generator/form.ts), so pickers can replace
 * these inputs later without touching the API.
 */

type FieldKey = keyof AdsGeneratorFormInput;

/**
 * Suggested offer-details structure (30 Oct 2026 prompt revision). More,
 * specific facts are what turn filler into useful headlines. No "Source:"
 * line: links are rejected by the server's relevance gate.
 */
const OFFER_DETAILS_PLACEHOLDER = [
  'Primary offer: Up to 40% off on selected styles',
  'Applies to: Shoes, ethnic wear',
  'Code: STYLE10 (or: not supplied)',
  'Conditions: Minimum order 999; new users only',
  'Other offer: Extra 10% with HDFC cards (not stackable)',
].join('\n');

const AD_TYPE_CHOICES = [
  { value: 'evergreen', label: 'Evergreen (recommended)', hint: 'Stays true on any day: no prices, codes or dates. Built from brand categories.' },
  { value: 'offer', label: 'Offer-specific', hint: 'Names the current offer. Regenerate or pause the ads when the offer changes.' },
];

type FieldSpec = { key: FieldKey; label: string; hint: string; placeholder?: string; required?: boolean; multiline?: boolean; col: number };

/** The one source field the chosen ad type uses (the server rejects the other). */
function sourceField(options: AdsGeneratorOptions, adType: string): FieldSpec {
  const { limits } = options;
  if (adType === 'evergreen') {
    return {
      key: 'brandCategories', label: 'Brand categories', required: true, col: 12,
      hint: `Comma-separated, up to ${limits.brandCategoriesMax}. What the brand sells; these fill the supporting headlines.`,
      placeholder: 'Fashion, shoes, ethnic wear, beauty',
    };
  }
  return {
    key: 'offerDetails', label: 'Offer details', multiline: true, required: true, col: 12,
    hint: `Up to ${limits.offerDetailsMax} characters. The ONLY source for numbers, codes, products and conditions in the ads. ` +
      'Use one line per item; write "not supplied" for anything unknown. Keep flat / up to / extra exactly as the offer says. No links.',
    placeholder: OFFER_DETAILS_PLACEHOLDER,
  };
}

function fieldSpecs(options: AdsGeneratorOptions, adType: string): FieldSpec[] {
  const { limits, currency } = options;
  const device = `Optional. Percent, ${limits.deviceAdjustmentExclude} or ${limits.deviceAdjustmentMin} to ${limits.deviceAdjustmentMax}. Blank = not set, 0 = reset.`;
  return [
    { key: 'campaignName', label: 'Campaign name', hint: 'Exact Google Ads campaign name.', placeholder: 'Myntra | Search | IN', required: true, col: 6 },
    { key: 'brandName', label: 'Brand name', hint: 'Full brand name; used in headline 1 and keywords.', placeholder: 'Myntra', required: true, col: 6 },
    { key: 'landingPage', label: 'Landing page', hint: 'A store page on any CouponzGuru website (.com, .ae, usa.com, .sg, .my, .ph).', placeholder: 'https://www.couponzguru.com/myntra-coupons/', required: true, col: 12 },
    { key: 'countries', label: 'Countries', hint: 'Comma-separated. USA / UAE / UK are expanded.', placeholder: 'India, UAE, USA', required: true, col: 6 },
    { key: 'label', label: 'Label', hint: 'One campaign label.', placeholder: 'VK Label', required: true, col: 6 },
    { key: 'dailyBudget', label: `Daily budget (${currency})`, hint: `${limits.dailyBudgetMin}–${limits.dailyBudgetMax}. One budget for all countries.`, placeholder: '5000', required: true, col: 6 },
    { key: 'targetCpa', label: `Target CPA (${currency})`, hint: `${limits.targetCpaMin}–${limits.targetCpaMax}.`, placeholder: '15', required: true, col: 6 },
    { key: 'mobileAdjustment', label: 'Mobile adjustment (%)', hint: device, placeholder: '-50', col: 4 },
    { key: 'tabletAdjustment', label: 'Tablet adjustment (%)', hint: device, placeholder: '-60', col: 4 },
    { key: 'desktopAdjustment', label: 'Desktop adjustment (%)', hint: device, placeholder: '0', col: 4 },
    sourceField(options, adType),
    { key: 'negativeKeywordLists', label: 'Negative keyword lists', hint: 'Optional. Comma-separated exact names of existing shared lists.', placeholder: 'Brand restricted', col: 12 },
  ];
}

export function AdsForm({ options, value, onChange, onSubmit, busy }: {
  options: AdsGeneratorOptions;
  value: AdsGeneratorFormInput;
  onChange: (next: AdsGeneratorFormInput) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const set = (key: FieldKey) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...value, [key]: event.target.value });
  // Switching type clears both source fields: each type accepts only its own.
  const setAdType = (adType: string) => onChange({ ...value, adType, offerDetails: '', brandCategories: '' });
  const choice = AD_TYPE_CHOICES.find((entry) => entry.value === value.adType);

  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <Flex direction="column" alignItems="stretch" gap={5}>
        <Field.Root name="adType" hint={choice?.hint} required>
          <Field.Label>Ad type</Field.Label>
          <SingleSelect value={value.adType} onChange={(next: string | number) => setAdType(String(next))}>
            {AD_TYPE_CHOICES.map((entry) => (
              <SingleSelectOption key={entry.value} value={entry.value}>{entry.label}</SingleSelectOption>
            ))}
          </SingleSelect>
          <Field.Hint />
        </Field.Root>
        <Grid.Root gap={5}>
          {fieldSpecs(options, value.adType).map((spec) => (
            <Grid.Item key={spec.key} col={spec.col} s={12} xs={12} direction="column" alignItems="stretch">
              <Field.Root name={spec.key} hint={spec.hint} required={spec.required}>
                <Field.Label>{spec.label}</Field.Label>
                {spec.multiline
                  ? <Textarea value={value[spec.key]} placeholder={spec.placeholder} onChange={set(spec.key)} />
                  : <TextInput value={value[spec.key]} placeholder={spec.placeholder} onChange={set(spec.key)} />}
                <Field.Hint />
              </Field.Root>
            </Grid.Item>
          ))}
        </Grid.Root>
        <Flex gap={3} alignItems="center">
          <Button type="submit" loading={busy} disabled={busy || !options.configured}>Generate ads</Button>
          <Typography variant="pi" textColor="neutral600">
            Creates one paused Search campaign CSV. Nothing is sent to Google Ads.
          </Typography>
        </Flex>
      </Flex>
    </form>
  );
}
