import { describe, expect, it } from 'vitest';
import { formInput } from './__fixtures__/ads-fixtures';
import { parseAdsBatch } from './batch';

describe('parseAdsBatch', () => {
  it('accepts one to ten campaigns', () => {
    const campaigns = Array.from({ length: 10 }, (_, index) => formInput({ campaignName: `Campaign ${index}` }));
    expect(parseAdsBatch({ campaigns })).toMatchObject({ ok: true });
    expect(parseAdsBatch({ campaigns: [...campaigns, formInput({ campaignName: 'Extra' })] })).toMatchObject({ ok: false });
    expect(parseAdsBatch({ campaigns: [] })).toMatchObject({ ok: false });
    expect(parseAdsBatch(formInput())).toMatchObject({ ok: false });
  });

  it('names the campaign each problem belongs to', () => {
    const parsed = parseAdsBatch({ campaigns: [formInput(), formInput({ campaignName: 'Two', dailyBudget: '' })] });
    expect('errors' in parsed && parsed.errors.every((error) => error.startsWith('Campaign 2:'))).toBe(true);
  });

  it('rejects duplicate campaign names', () => {
    const parsed = parseAdsBatch({ campaigns: [formInput(), formInput({ campaignName: 'test myntra' })] });
    expect(parsed).toMatchObject({ ok: false, errors: ['Campaign 2: same campaign name as Campaign 1.'] });
  });
});
