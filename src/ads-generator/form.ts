import {
  ADS_AD_TYPES,
  ADS_COUNTRY_ALIASES,
  ADS_FORM_LIMITS as LIMITS,
  type AdsAdType,
  type AdsGeneratorFormInput,
} from '../constants/ads-generator';

/**
 * Turns the settings-page text form into typed values, collecting every
 * problem at once so one submit reports all of them. Nothing here calls the
 * network; a failure means no OpenAI call is made.
 */

export type DeviceKey = 'mobileAdjustment' | 'tabletAdjustment' | 'desktopAdjustment';

export type AdsForm = {
  adType: AdsAdType;
  campaignName: string;
  brandName: string;
  countries: string[];
  landingPage: string;
  dailyBudget: number;
  targetCpa: number;
  label: string;
  mobileAdjustment: number | null;
  tabletAdjustment: number | null;
  desktopAdjustment: number | null;
  negativeKeywordLists: string[];
  /** Offer ads only (required there, empty for evergreen). */
  offerDetails: string;
  /** Evergreen ads only (required there, empty for offer). */
  brandCategories: string[];
};

export type ParsedAdsForm = { ok: true; form: AdsForm } | { ok: false; errors: string[] };

const FORM_KEYS: Array<keyof AdsGeneratorFormInput> = [
  'adType', 'brandCategories', 'campaignName', 'brandName', 'countries', 'landingPage', 'dailyBudget', 'targetCpa', 'label',
  'mobileAdjustment', 'tabletAdjustment', 'desktopAdjustment', 'negativeKeywordLists', 'offerDetails',
];
const DEVICE_KEYS: DeviceKey[] = ['mobileAdjustment', 'tabletAdjustment', 'desktopAdjustment'];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAK = /[\r\n]/;
/** Spreadsheet formula triggers when a cell starts with one of these. */
const FORMULA_PREFIX = /^[=+\-@\t]/;

export function parseAdsForm(body: unknown): ParsedAdsForm {
  const errors: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['Request body must be a form object.'] };
  }
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !FORM_KEYS.includes(key as keyof AdsGeneratorFormInput));
  if (unknown.length) errors.push(`Unknown fields: ${unknown.join(', ')}.`);

  const text = (key: keyof AdsGeneratorFormInput): string => {
    const value = raw[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
      errors.push(`${key} must be text.`);
      return '';
    }
    return value.trim();
  };

  const adType = parseAdType(text('adType'), errors);
  const campaignName = singleLine('Campaign name', text('campaignName'), LIMITS.campaignNameMax, errors, true);
  const brandName = singleLine('Brand name', text('brandName'), LIMITS.brandNameMax, errors, true);
  const label = singleLine('Label', text('label'), LIMITS.labelMax, errors, true);
  if (label.includes(';')) errors.push('Label must be one label name without semicolons.');

  const landingPage = parseLandingPage(text('landingPage'), errors);
  const countries = parseList('Countries', text('countries'), LIMITS.countriesMax, LIMITS.countryNameMax, errors)
    .map((country) => ADS_COUNTRY_ALIASES[country.toUpperCase()] ?? country);
  if (!countries.length) errors.push('Countries is required.');
  if (new Set(countries.map((c) => c.toLowerCase())).size !== countries.length) {
    errors.push('Countries contains duplicates.');
  }
  const negativeKeywordLists = parseList(
    'Negative keyword lists', text('negativeKeywordLists'),
    LIMITS.negativeListsMax, LIMITS.negativeListNameMax, errors,
  );
  if (new Set(negativeKeywordLists).size !== negativeKeywordLists.length) {
    errors.push('Negative keyword lists contains duplicates.');
  }

  const dailyBudget = parseAmount('Daily budget', text('dailyBudget'), LIMITS.dailyBudgetMin, LIMITS.dailyBudgetMax, errors);
  const targetCpa = parseAmount('Target CPA', text('targetCpa'), LIMITS.targetCpaMin, LIMITS.targetCpaMax, errors);
  const devices = Object.fromEntries(
    DEVICE_KEYS.map((key) => [key, parseDevice(key, text(key), errors)]),
  ) as Record<DeviceKey, number | null>;

  const offerDetails = text('offerDetails');
  if (offerDetails.length > LIMITS.offerDetailsMax) {
    errors.push(`Offer details must be at most ${LIMITS.offerDetailsMax} characters.`);
  }
  if (CONTROL_CHARS.test(offerDetails)) errors.push('Offer details contains control characters.');

  const brandCategories = parseList(
    'Brand categories', text('brandCategories'), LIMITS.brandCategoriesMax, LIMITS.brandCategoryNameMax, errors,
  );
  checkAdTypeFields(adType, offerDetails, brandCategories, errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    form: {
      adType, campaignName, brandName, countries, landingPage, dailyBudget, targetCpa, label,
      ...devices, negativeKeywordLists, offerDetails, brandCategories,
    },
  };
}

function parseAdType(value: string, errors: string[]): AdsAdType {
  if ((ADS_AD_TYPES as readonly string[]).includes(value)) return value as AdsAdType;
  errors.push(`Ad type must be one of: ${ADS_AD_TYPES.join(', ')}.`);
  return 'evergreen';
}

/**
 * Each ad type uses exactly one source field. The other must be empty, so a
 * value is never silently ignored, and the required one is checked here so
 * an empty brief never reaches (and pays for) the model.
 */
function checkAdTypeFields(adType: AdsAdType, offerDetails: string, brandCategories: string[], errors: string[]): void {
  if (adType === 'evergreen') {
    if (!brandCategories.length) errors.push('Brand categories is required for Evergreen ads, e.g. "Fashion, shoes, beauty".');
    if (offerDetails) errors.push('Offer details are not used by Evergreen ads; clear the field or choose Offer-specific.');
  } else {
    if (!offerDetails) errors.push('Offer details is required for Offer-specific ads.');
    if (brandCategories.length) errors.push('Brand categories are only used by Evergreen ads; clear the field or choose Evergreen.');
  }
}

function singleLine(name: string, value: string, max: number, errors: string[], required: boolean): string {
  if (!value) {
    if (required) errors.push(`${name} is required.`);
    return value;
  }
  if (value.length > max) errors.push(`${name} must be at most ${max} characters.`);
  if (LINE_BREAK.test(value) || CONTROL_CHARS.test(value)) errors.push(`${name} must be a single line.`);
  if (FORMULA_PREFIX.test(value)) errors.push(`${name} must not start with = + - @ or a tab.`);
  return value;
}

/** Comma-separated text → trimmed, non-empty items. */
function parseList(name: string, value: string, maxItems: number, maxLength: number, errors: string[]): string[] {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length > maxItems) errors.push(`${name} allows at most ${maxItems} entries.`);
  for (const item of items) singleLine(`${name} entry "${item.slice(0, 20)}"`, item, maxLength, errors, true);
  return items;
}

function parseLandingPage(value: string, errors: string[]): string {
  if (!value) {
    errors.push('Landing page is required.');
    return value;
  }
  if (value.length > LIMITS.landingPageMax) {
    errors.push(`Landing page must be at most ${LIMITS.landingPageMax} characters.`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') errors.push('Landing page must use https://.');
    if (url.username || url.password) errors.push('Landing page must not contain credentials.');
  } catch {
    errors.push('Landing page must be a full URL, e.g. https://www.couponzguru.com/brand/.');
  }
  return value;
}

/** Plain decimal number only: "5000" or "15.5", no currency symbols or commas. */
function parseNumber(value: string): number | null {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAmount(name: string, value: string, min: number, max: number, errors: string[]): number {
  if (!value) {
    errors.push(`${name} is required.`);
    return 0;
  }
  const parsed = parseNumber(value);
  if (parsed === null) {
    errors.push(`${name} must be a plain number like 5000 or 15.5.`);
    return 0;
  }
  if (parsed < min || parsed > max) errors.push(`${name} must be between ${min} and ${max}.`);
  return parsed;
}

/** Blank → null (omitted). Explicit 0 is kept: it is a real setting. */
function parseDevice(key: DeviceKey, value: string, errors: string[]): number | null {
  if (!value) return null;
  const parsed = parseNumber(value);
  const valid = parsed !== null && Number.isInteger(parsed) && (
    parsed === LIMITS.deviceAdjustmentExclude ||
    (parsed >= LIMITS.deviceAdjustmentMin && parsed <= LIMITS.deviceAdjustmentMax)
  );
  if (!valid) {
    errors.push(
      `${key} must be a whole percentage: ${LIMITS.deviceAdjustmentExclude}, or ` +
      `${LIMITS.deviceAdjustmentMin} to ${LIMITS.deviceAdjustmentMax}.`,
    );
    return null;
  }
  return parsed;
}
