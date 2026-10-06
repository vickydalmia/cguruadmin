import { describe, expect, it, vi } from 'vitest';
import schema from '../../../components/shared/sale-strip.json';
import { GLOBAL_POPULATE } from '../../homepage/controllers/homepage-populate';
import { validateSaleStrip, validateSaleStripForWrite } from './sale-strip-validation';
import { computeScope } from '../../../isr-outbox/scopes';
const valid = { ...Object.fromEntries(Object.entries(schema.attributes).map(([key, value]) => [key, 'default' in value ? value.default : null])), enabled: true, ctaUrl: '/festival/' };

describe('global entity sale strip', () => {
  it('requires valid content when only the homepage placement is enabled', () => {
    expect(() => validateSaleStrip({ ...valid, enabled: false, homepageEnabled: true })).not.toThrow();
    expect(() => validateSaleStrip({ ...valid, enabled: false, homepageEnabled: true, ctaUrl: '' })).toThrow();
    expect(() => validateSaleStrip({ enabled: false, homepageEnabled: false })).not.toThrow();
  });
  it('refreshes cached pages and shared chrome when Global Settings are saved', async () => {
    await expect(computeScope({} as any, 'api::global.global', 'update', 'global-id'))
      .resolves.toEqual({ full: true, refreshScopes: ['chrome'] });
  });
  it('allows empty disabled settings and validates complete enabled settings', () => {
    expect(() => validateSaleStrip(null)).not.toThrow();
    expect(() => validateSaleStrip({ enabled: false })).not.toThrow();
    expect(() => validateSaleStrip(valid)).not.toThrow();
    expect(GLOBAL_POPULATE.saleStrip).toEqual({ populate: { logo: true } });
  });
  it('collects missing copy, stats and destination as inline errors', () => {
    try { validateSaleStrip({ enabled: true }); throw new Error('Expected validation'); }
    catch (error: any) {
      expect(error.details.errors).toHaveLength(12);
      expect(error.details.errors).toContainEqual(expect.objectContaining({ path: ['saleStrip', 'ctaUrl'] }));
    }
    expect(() => validateSaleStrip({ ...valid, heading: '  ' })).toThrow();
  });
  it.each(['javascript:alert(1)', '//evil.test', '/\\evil.test', 'https://user:pass@example.com', 'bad path'])('rejects unsafe destination %s', (ctaUrl) => {
    expect(() => validateSaleStrip({ ...valid, ctaUrl })).toThrow();
  });
  it('validates partial updates against saved component data', async () => {
    const findOne = vi.fn(async () => ({ saleStrip: valid }));
    const strapi = { documents: () => ({ findOne }) } as any;
    await expect(validateSaleStripForWrite(strapi, { saleStrip: { enabled: true } }, 'global-id', 'en')).resolves.toBeUndefined();
    await expect(validateSaleStripForWrite(strapi, { saleStrip: { ctaUrl: null } }, 'global-id', 'en')).rejects.toThrow();
    await expect(validateSaleStripForWrite(strapi, { saleStrip: null }, 'global-id', 'en')).resolves.toBeUndefined();
  });
});
