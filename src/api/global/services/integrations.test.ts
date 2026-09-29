import { describe, it, expect, vi } from 'vitest';
import { normalizeIntegrations, validateIntegrations, validateIntegrationsForWrite, loadNewsletterConfig } from './integrations';
import schema from '../content-types/global/schema.json';
import routes from '../routes/custom';
import isrAdminAuth from '../../../policies/isr-admin-auth';

describe('Global integrations', () => {
  it('trims values and allows all integrations to be cleared', () => {
    const data = { telegramUrl: ' https://t.me/channel ', whatsappUrl: ' ', sendyUrl: '', sendyListId: ' ' };
    normalizeIntegrations(data);
    expect(data).toEqual({ telegramUrl: 'https://t.me/channel', whatsappUrl: null, sendyUrl: null, sendyListId: null });
    expect(() => validateIntegrations(data)).not.toThrow();
  });
  it.each(['javascript:alert(1)', '//t.me/channel', 'https://t.me/a b', 'https://user:password@example.com'])('rejects invalid channel URL %s', (telegramUrl) => {
    expect(() => validateIntegrations({ telegramUrl })).toThrow();
  });
  it.each(['http://sendy.example.com', 'https://sendy.example.com/?key=x', 'https://sendy.example.com/#section'])('rejects invalid Sendy base %s', (sendyUrl) => {
    expect(() => validateIntegrations({ sendyUrl, sendyListId: 'list' })).toThrow();
  });
  it('accepts a Sendy path and rejects incomplete pairs', () => {
    expect(() => validateIntegrations({ sendyUrl: 'https://example.com/sendy/', sendyListId: 'list' })).not.toThrow();
    expect(() => validateIntegrations({ sendyUrl: 'https://example.com' })).toThrow(/both/);
    expect(() => validateIntegrations({ sendyListId: 'list' })).toThrow(/both/);
  });
  it('merges partial saves with the stored language row', async () => {
    const findOne = vi.fn().mockResolvedValue({ sendyUrl: 'https://example.com', sendyListId: 'old' });
    const strapi = { documents: () => ({ findOne }) } as any;
    await validateIntegrationsForWrite(strapi, { sendyListId: 'new' }, 'global-id', 'ar');
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'global-id', locale: 'ar' }));
    await expect(validateIntegrationsForWrite(strapi, { sendyUrl: null }, 'global-id')).rejects.toThrow(/both/);
    await expect(validateIntegrationsForWrite(strapi, { sendyUrl: null, sendyListId: null }, 'global-id')).resolves.toBeUndefined();
  });
  it('keeps Sendy fields private and does not define a token field', () => {
    expect(schema.attributes.sendyUrl.private).toBe(true);
    expect(schema.attributes.sendyListId.private).toBe(true);
    expect(Object.keys(schema.attributes)).not.toContain('sendyApiKey');
    for (const field of ['telegramUrl', 'whatsappUrl', 'sendyUrl', 'sendyListId'] as const) {
      expect(schema.attributes[field].pluginOptions.i18n.localized).toBe(false);
    }
  });
  it('returns only newsletter configuration from the default language', async () => {
    const findFirst = vi.fn().mockResolvedValue({ sendyUrl: 'https://example.com', sendyListId: 'list', headerCode: 'private' });
    expect(await loadNewsletterConfig({ documents: () => ({ findFirst }) } as any)).toEqual({ sendyUrl: 'https://example.com', sendyListId: 'list' });
    expect(findFirst).toHaveBeenCalledWith({ locale: 'en', fields: ['sendyUrl', 'sendyListId'] });
  });
  it('protects the endpoint with the existing server authentication policy', () => {
    expect(routes.routes[0].config).toEqual({ auth: false, policies: ['global::isr-admin-auth'] });
    const before = process.env.ISR_ADMIN_SECRET;
    try {
      process.env.ISR_ADMIN_SECRET = 'server-secret';
      expect(isrAdminAuth({ get: () => '' }, {}, { strapi: {} })).toBe(false);
      expect(isrAdminAuth({ get: () => 'Bearer wrong' }, {}, { strapi: {} })).toBe(false);
      expect(isrAdminAuth({ get: () => 'Bearer server-secret' }, {}, { strapi: {} })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ISR_ADMIN_SECRET;
      else process.env.ISR_ADMIN_SECRET = before;
    }
  });
});
