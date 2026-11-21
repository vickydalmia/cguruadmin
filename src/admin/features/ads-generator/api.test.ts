import { describe, expect, it, vi } from 'vitest';
import { adsGeneratorApi, adsGeneratorError, EMPTY_FORM, GENERATE_PATH, jobFailure, jobPath, OPTIONS_PATH, progressLabel } from './api';

describe('ads generator admin api', () => {
  it('calls the admin routes', async () => {
    const client = { get: vi.fn().mockResolvedValue({ data: { id: 'j' } }), post: vi.fn().mockResolvedValue({ data: { id: 'j', status: 'running' } }) };
    const api = adsGeneratorApi(client as any);
    await api.options();
    await expect(api.generate(EMPTY_FORM)).resolves.toEqual({ id: 'j', status: 'running' });
    await api.job('a b');
    expect(client.get).toHaveBeenCalledWith(OPTIONS_PATH);
    expect(client.post).toHaveBeenCalledWith(GENERATE_PATH, EMPTY_FORM);
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

  it('turns a failed job into the notice the page shows', () => {
    const job = { id: 'j', status: 'failed', attempt: 3, maxAttempts: 3, startedAt: '', error: { message: 'Still invalid.', problems: ['H1 too long'] } } as const;
    expect(jobFailure(job)).toEqual({ message: 'Still invalid.', problems: ['H1 too long'], forbidden: false });
  });

  it('describes progress by OpenAI call', () => {
    const base = { id: 'j', status: 'running', maxAttempts: 3, startedAt: '' } as const;
    expect(progressLabel({ ...base, attempt: 1 })).toBe('Writing the ad…');
    expect(progressLabel({ ...base, attempt: 2 })).toBe('Fixing the copy (OpenAI call 2 of 3)…');
  });
});
