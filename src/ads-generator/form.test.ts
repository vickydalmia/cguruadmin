import { describe, expect, it } from 'vitest';
import { evergreenForm, evergreenFormInput, formInput, parsedForm } from './__fixtures__/ads-fixtures';
import { parseAdsForm } from './form';

describe('parseAdsForm', () => {
  it('turns the text form into typed values', () => {
    expect(parseAdsForm(formInput())).toEqual({ ok: true, form: parsedForm() });
  });

  it('keeps an explicit 0 device adjustment and omits blank ones', () => {
    const result = parseAdsForm(formInput({ mobileAdjustment: '', desktopAdjustment: '0' }));
    expect(result).toMatchObject({ ok: true, form: { mobileAdjustment: null, desktopAdjustment: 0 } });
  });

  it('allows blank optional fields', () => {
    const result = parseAdsForm(formInput({ negativeKeywordLists: '  ', mobileAdjustment: '' }));
    expect(result).toMatchObject({ ok: true, form: { negativeKeywordLists: [], mobileAdjustment: null } });
  });

  it('parses an evergreen form with brand categories', () => {
    expect(parseAdsForm(evergreenFormInput())).toEqual({ ok: true, form: evergreenForm() });
  });

  it('requires the source field of the chosen ad type and rejects the other one', () => {
    expect(parseAdsForm(evergreenFormInput({ brandCategories: '' }))).toEqual({
      ok: false, errors: ['Brand categories is required for Evergreen ads, e.g. "Fashion, shoes, beauty".'],
    });
    expect(parseAdsForm(evergreenFormInput({ offerDetails: 'Flat 40% off' }))).toEqual({
      ok: false, errors: ['Offer details are not used by Evergreen ads; clear the field or choose Offer-specific.'],
    });
    expect(parseAdsForm(formInput({ offerDetails: '' }))).toEqual({
      ok: false, errors: ['Offer details is required for Offer-specific ads.'],
    });
    expect(parseAdsForm(formInput({ brandCategories: 'Shoes' }))).toEqual({
      ok: false, errors: ['Brand categories are only used by Evergreen ads; clear the field or choose Evergreen.'],
    });
  });

  it('rejects an unknown ad type', () => {
    expect(parseAdsForm(formInput({ adType: 'seasonal' }))).toMatchObject({
      ok: false, errors: expect.arrayContaining(['Ad type must be one of: evergreen, offer.']),
    });
  });

  it('reports every problem at once', () => {
    const result = parseAdsForm(formInput({
      campaignName: '', countries: '', landingPage: 'http://www.couponzguru.com/',
      dailyBudget: '5,000', targetCpa: '0', mobileAdjustment: '-95', label: 'A;B',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'Campaign name is required.',
      'Label must be one label name without semicolons.',
      'Landing page must use https://.',
      'Countries is required.',
      'Daily budget must be a plain number like 5000 or 15.5.',
      'Target CPA must be between 1 and 10000.',
      'mobileAdjustment must be a whole percentage: -100, or -90 to 900.',
    ]);
  });

  it('rejects unknown fields, non-text values and formula prefixes', () => {
    const result = parseAdsForm({ ...formInput({ brandName: '=HYPERLINK("x")' }), extra: 'x', label: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('Unknown fields: extra.');
    expect(result.errors).toContain('label must be text.');
    expect(result.errors).toContain('Brand name must not start with = + - @ or a tab.');
  });

  it('rejects duplicate countries after alias expansion', () => {
    const result = parseAdsForm(formInput({ countries: 'USA, United States' }));
    expect(result).toMatchObject({ ok: false, errors: ['Countries contains duplicates.'] });
  });

  it('accepts -100 to exclude a device', () => {
    expect(parseAdsForm(formInput({ tabletAdjustment: '-100' }))).toMatchObject({ ok: true, form: { tabletAdjustment: -100 } });
  });
});
