import { describe, expect, it } from 'vitest';
import { parsedForm, validOutput } from '../__fixtures__/ads-fixtures';
import { buildKeywords, buildNewCampaignRows } from './build-rows';
import { GOOGLE_ADS_CSV_COLUMNS } from './columns';
import { serializeCsv } from './serialize';

function rows(overrides = {}) {
  const form = parsedForm(overrides);
  return buildNewCampaignRows(form, buildKeywords(form.brandName), validOutput().ads);
}

describe('buildNewCampaignRows', () => {
  it('writes rows in upload order: campaign, ad group, keywords, ads, lists', () => {
    expect(rows().map((row) => row['Row Type'])).toEqual([
      'Campaign', 'Ad group', ...Array(10).fill('Keyword'), 'Ad', '',
    ]);
  });

  it('takes every campaign setting from the form', () => {
    expect(rows()[0]).toMatchObject({
      Action: 'Add',
      'Campaign status': 'Paused',
      Campaign: 'Test Myntra',
      Networks: 'Google search',
      Budget: '5000',
      'Target CPA': '15',
      Location: 'India; United Arab Emirates; United States',
      Devices: 'Mobile devices with full browsers:-50%; Computers:0%',
      Label: 'VK Label',
      'EU political ads': 'No',
    });
  });

  it('omits the device setting when no adjustment is supplied', () => {
    const [campaign] = rows({ mobileAdjustment: null, desktopAdjustment: null });
    expect(campaign.Devices).toBe('');
  });

  it('builds phrase keywords from the brand and pins the RSA', () => {
    const all = rows();
    expect(all[2]).toMatchObject({ Keyword: 'myntra coupon', Type: 'Phrase match', 'Ad group': 'Myntra | Coupons & Discounts' });
    expect(all[12]).toMatchObject({
      'Final URL': 'https://www.couponzguru.com/myntra-coupons/',
      'Headline 1': 'Myntra Coupons & Discounts',
      'Headline 1 position': '1', 'Headline 2 position': '2', 'Description 1 position': '1',
      'Path 1': 'coupons', 'Path 2': 'deals',
    });
    expect(all[13]).toEqual({
      'Row Type': '', Action: 'Add', Campaign: 'Test Myntra', 'Negative keyword': 'Brand restricted', 'Keyword or list': 'List',
    });
  });
});

describe('serializeCsv', () => {
  it('writes BOM, the 97 fixed headers and CRLF lines', () => {
    const csv = serializeCsv(rows());
    expect(GOOGLE_ADS_CSV_COLUMNS).toHaveLength(97);
    expect(csv.startsWith('﻿Row Type,Action,')).toBe(true);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(1 + 14 + 1);
    expect(lines[lines.length - 1]).toBe('');
  });

  it('quotes commas and quotes', () => {
    const csv = serializeCsv([{ 'Row Type': 'Campaign', Campaign: 'Say "hi", ok' }]);
    expect(csv.split('\r\n')[1].startsWith('Campaign,,,,"Say ""hi"", ok"')).toBe(true);
  });

  it('refuses formula values and unknown columns', () => {
    expect(() => serializeCsv([{ Campaign: '=cmd' }])).toThrow('Unsafe CSV value');
    expect(() => serializeCsv([{ Results: 'x' } as any])).toThrow('Unknown CSV columns: Results');
  });
});
