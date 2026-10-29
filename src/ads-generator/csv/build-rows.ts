import { ADS_CAMPAIGN_DEFAULTS as D, ADS_DEVICE_NAMES, ADS_KEYWORD_SUFFIXES } from '../../constants/ads-generator';
import type { AdsForm, DeviceKey } from '../form';
import type { GeneratedAd } from '../../constants/ads-generator';
import type { GoogleAdsCsvColumn } from './columns';

/**
 * Rows for ONE new paused Search campaign, in upload order: campaign, ad
 * group, keywords, ads, shared negative-list associations. Every operational
 * value comes from the validated form, never from the model.
 */

export type CsvRow = Partial<Record<GoogleAdsCsvColumn, string>>;

export function buildKeywords(brandName: string): string[] {
  return ADS_KEYWORD_SUFFIXES.map((suffix) => `${brandName.toLowerCase()} ${suffix}`);
}

export function adGroupName(brandName: string): string {
  return `${brandName}${D.adGroupSuffix}`;
}

export function buildNewCampaignRows(form: AdsForm, keywords: string[], ads: GeneratedAd[]): CsvRow[] {
  const campaign = form.campaignName;
  const adGroup = adGroupName(form.brandName);
  return [
    campaignRow(form),
    {
      'Row Type': 'Ad group', Action: 'Add', Campaign: campaign, 'Ad group': adGroup,
      'Ad group status': D.entityStatus, 'Ad group type': D.adGroupType,
    },
    ...keywords.map((keyword): CsvRow => ({
      'Row Type': 'Keyword', Action: 'Add', Campaign: campaign, 'Ad group': adGroup,
      'Keyword status': D.entityStatus, Keyword: keyword, Type: D.keywordMatchType,
    })),
    ...ads.map((ad) => adRow(form, adGroup, ad)),
    // Shared-list association: Row Type intentionally EMPTY (kit encoding).
    ...form.negativeKeywordLists.map((list): CsvRow => ({
      'Row Type': '', Action: 'Add', Campaign: campaign, 'Negative keyword': list, 'Keyword or list': 'List',
    })),
  ];
}

function campaignRow(form: AdsForm): CsvRow {
  return {
    'Row Type': 'Campaign',
    Action: 'Add',
    'Campaign status': D.entityStatus,
    Campaign: form.campaignName,
    'Campaign type': D.campaignType,
    Networks: D.networks,
    Budget: formatNumber(form.dailyBudget),
    'Budget type': D.budgetType,
    'Bid strategy type': D.bidStrategyType,
    'Target CPA': formatNumber(form.targetCpa),
    Location: form.countries.join('; '),
    Devices: deviceSetting(form),
    Label: form.label,
    'EU political ads': D.euPoliticalAds,
  };
}

function adRow(form: AdsForm, adGroup: string, ad: GeneratedAd): CsvRow {
  const row: CsvRow = {
    'Row Type': 'Ad', Action: 'Add', Campaign: form.campaignName, 'Ad group': adGroup,
    'Ad status': D.entityStatus, 'Ad type': D.adType, 'Final URL': form.landingPage,
    'Path 1': D.path1, 'Path 2': D.path2,
    // Pins: brand headline, offer headline and the main description.
    'Headline 1 position': '1', 'Headline 2 position': '2', 'Description 1 position': '1',
  };
  ad.headlines.forEach((text, i) => { row[`Headline ${i + 1}` as GoogleAdsCsvColumn] = text; });
  ad.descriptions.forEach((text, i) => { row[`Description ${i + 1}` as GoogleAdsCsvColumn] = text; });
  return row;
}

/** "Mobile devices with full browsers:-50%; Computers:0%". Blank devices are omitted. */
function deviceSetting(form: AdsForm): string {
  return (Object.keys(ADS_DEVICE_NAMES) as DeviceKey[])
    .filter((key) => form[key] !== null)
    .map((key) => `${ADS_DEVICE_NAMES[key]}:${form[key]}%`)
    .join('; ');
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}
