import { describe, expect, it, vi } from 'vitest';
import { adsGeneratorApi, adsGeneratorError, duplicateRow, EMPTY_FORM, GENERATE_PATH, jobPath, newRow, OPTIONS_PATH, progressLabel, downloadableCsv, restoredLanguage, restoredRows, retryRequest } from './api';

describe('ads generator admin api', () => {
  it('calls the admin routes', async () => {
    const client = { get: vi.fn().mockResolvedValue({ data: { id: 'j' } }), post: vi.fn().mockResolvedValue({ data: { id: 'j', status: 'running' } }) };
    const api = adsGeneratorApi(client as any);
    await api.options();
    await expect(api.generate({ campaigns: [EMPTY_FORM] })).resolves.toEqual({ id: 'j', status: 'running' });
    await api.job('a b');
    expect(client.get).toHaveBeenCalledWith(OPTIONS_PATH);
    expect(client.post).toHaveBeenCalledWith(GENERATE_PATH, { campaigns: [EMPTY_FORM] });
    expect(client.get).toHaveBeenCalledWith('/ads-generator/jobs/a%20b');
    expect(jobPath('x')).toBe('/ads-generator/jobs/x');
  });

  it('reads the server error and its problems', () => {
    expect(adsGeneratorError({ response: { status: 400, data: { error: 'Fix the form.', problems: ['Label is required.'] } } }))
      .toEqual({ message: 'Fix the form.', problems: ['Label is required.'], forbidden: false });
  });

  it('explains a 403', () => {
    expect(adsGeneratorError({ response: { status: 403, data: { error: { message: 'Policy Failed' } } } }))
      .toEqual({ message: 'Your role needs the “Generate Google Ads” permission.', problems: [], forbidden: true });
  });

  it('describes progress by OpenAI call', () => {
    const base = { id: 'j', status: 'running', maxAttempts: 3, startedAt: '' } as const;
    expect(progressLabel({ ...base, attempt: 1 })).toBe('Writing the ad…');
    expect(progressLabel({ ...base, attempt: 2 })).toBe('Fixing the copy (OpenAI call 2 of 3)…');
  });

  it('counts finished campaigns in a batch', () => {
    const run = (status: 'running' | 'succeeded' | 'failed', index: number) => ({ index, campaignName: String(index), key: String(index), status, attempt: 1 });
    expect(progressLabel({ id: 'j', status: 'running', attempt: 0, maxAttempts: 3, startedAt: '', result: { campaigns: [run('succeeded', 0), run('failed', 1), run('running', 2)] } }))
      .toBe('Generated 2 of 3 campaigns…');
  });

  it('downloads the Arabic CSV when there is one and restores the language', () => {
    const csv = { filename: 'a.csv', content: 'en', rows: 1 };
    const ar = { filename: 'a-ar.csv', content: 'ar', rows: 1 };
    expect(downloadableCsv({ csv } as any)).toBe(csv);
    expect(downloadableCsv({ csv, arabic: { csv: ar } } as any)).toBe(ar);
    expect(restoredLanguage({ language: 'ar' })).toBe('ar');
    expect(restoredLanguage({})).toBe('en');
  });

  it('gives repeated copies unique names within the length limit', () => {
    const row = newRow({ ...EMPTY_FORM, campaignName: 'Myntra' });
    const first = duplicateRow(row, [row]);
    expect(duplicateRow(row, [row, first]).value.campaignName).toBe('Myntra Copy 2');
    const long = newRow({ ...EMPTY_FORM, campaignName: 'x'.repeat(100) });
    expect(duplicateRow(long, [long]).value.campaignName).toHaveLength(100);
  });

  it('retries failed campaigns only, with their current fields', () => {
    const good = newRow({ ...EMPTY_FORM, campaignName: 'Good' });
    const bad = newRow({ ...EMPTY_FORM, campaignName: 'Bad', brandName: 'Fixed' });
    const run = (index: number, status: 'succeeded' | 'failed') => ({ index, campaignName: String(index), key: String(index), status, attempt: 1 });
    const job = { id: 'j', status: 'succeeded', attempt: 0, maxAttempts: 3, startedAt: '', input: { campaigns: [good.value, EMPTY_FORM] }, result: { campaigns: [run(0, 'succeeded'), run(1, 'failed')] } } as const;
    expect(retryRequest(job as any, [good, bad], [good.id, bad.id])).toEqual({ retryJobId: 'j', replacements: [{ index: 1, form: bad.value }] });
    expect(retryRequest(job as any, [good], [good.id, bad.id]).replacements[0].form).toEqual(EMPTY_FORM);
  });

  it('duplicates a row under a new name and restores known fields only', () => {
    const row = newRow({ ...EMPTY_FORM, campaignName: 'Myntra' });
    expect(duplicateRow(row)).toMatchObject({ value: { campaignName: 'Myntra Copy' } });
    expect(duplicateRow(row).id).not.toBe(row.id);
    const [restored] = restoredRows({ campaigns: [{ brandName: 'Nike', other: 'x' }] })!;
    expect(restored.value.brandName).toBe('Nike');
    expect(restored.value).not.toHaveProperty('other');
    expect(restoredRows(null)).toBeNull();
  });
});
