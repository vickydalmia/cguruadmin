import { describe, expect, it, vi } from 'vitest';
import { adsGeneratorApi, adsGeneratorError, EMPTY_FORM, GENERATE_PATH, OPTIONS_PATH } from './api';

describe('ads generator admin api', () => {
  it('calls the admin routes', async () => {
    const client = { get: vi.fn().mockResolvedValue({ data: { configured: true } }), post: vi.fn().mockResolvedValue({ data: { ads: [] } }) };
    const api = adsGeneratorApi(client as any);
    await expect(api.options()).resolves.toEqual({ configured: true });
    await expect(api.generate(EMPTY_FORM)).resolves.toEqual({ ads: [] });
    expect(client.get).toHaveBeenCalledWith(OPTIONS_PATH);
    expect(client.post).toHaveBeenCalledWith(GENERATE_PATH, EMPTY_FORM);
  });

  it('reads the server error and its problems', () => {
    expect(adsGeneratorError({ response: { status: 400, data: { error: 'Fix the form.', problems: ['Label is required.'] } } }))
      .toEqual({ message: 'Fix the form.', problems: ['Label is required.'], forbidden: false });
  });

  it('explains a 403', () => {
    expect(adsGeneratorError({ response: { status: 403, data: { error: { message: 'Policy Failed' } } } }))
      .toEqual({ message: 'Your role needs the “Generate Google Ads” permission.', problems: [], forbidden: true });
  });
});
