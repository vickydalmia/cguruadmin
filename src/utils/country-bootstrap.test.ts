import { afterEach, expect, it, vi } from 'vitest';
import { loadSiteConfiguration } from '../api/site-configuration/services/site-configuration';
const { readCountryBootstrap } = require('../../database/country-bootstrap.js');
const { checkDatabaseCountry, preflightDatabaseConfig } = require('../../deploy/scripts/check-country.cjs');
const seed = { siteName: 'CouponzGuru', countryName: 'United States', countryCode: 'US',
  locale: 'en-US', timezone: 'America/New_York', currencyCode: 'USD' };
afterEach(() => vi.unstubAllEnvs());
it('uses the same schema as Strapi', () => {
  expect(preflightDatabaseConfig({ connection: { client: 'postgres', connection: { schema: 'tenant_us' } } }).searchPath).toEqual(['tenant_us']);
});
it('requires a complete explicit identity and rejects mismatched countries', () => {
  expect(readCountryBootstrap('US', JSON.stringify(seed))).toEqual(seed);
  expect(() => readCountryBootstrap('AE', JSON.stringify(seed))).toThrow('match');
  expect(() => readCountryBootstrap('US', '{}')).toThrow('requires');
  expect(() => readCountryBootstrap('US', JSON.stringify({ ...seed, locale: 'en-IN' }))).toThrow('deployment country');
});
it('allows only empty non-India databases with an explicit bootstrap', async () => {
  const db: any = vi.fn(() => ({ select: () => ({ first: async () => ({ id: 1 }) }) }));
  db.schema = { hasTable: vi.fn(async () => false) };
  await expect(checkDatabaseCountry(db, 'US', '')).rejects.toThrow('does not match');
  await expect(checkDatabaseCountry(db, 'US', JSON.stringify(seed))).resolves.toBeUndefined();
  db.schema.hasTable.mockImplementation(async (table: string) => table === 'homepages');
  await expect(checkDatabaseCountry(db, 'US', JSON.stringify(seed))).rejects.toThrow('empty content database');
});
it('opens Country Setup with the explicit identity and translation disabled', async () => {
  vi.stubEnv('DEPLOYMENT_COUNTRY_CODE', 'US');
  vi.stubEnv('COUNTRY_SETUP_BOOTSTRAP_JSON', JSON.stringify(seed));
  const strapi = { documents: () => ({ findFirst: async () => null }),
    db: { connection: { schema: { hasTable: async () => false } } } } as any;
  expect(await loadSiteConfiguration(strapi)).toMatchObject({ ...seed, translationEnabled: false,
    onboardingComplete: false, storesEnabled: false });
});
it('never overrides a saved configuration with bootstrap values', async () => {
  vi.stubEnv('DEPLOYMENT_COUNTRY_CODE', 'US');
  vi.stubEnv('COUNTRY_SETUP_BOOTSTRAP_JSON', 'invalid leftover value');
  const strapi = { documents: () => ({ findFirst: async () => ({ ...seed, siteName: 'Saved name' }) }) } as any;
  expect(await loadSiteConfiguration(strapi)).toMatchObject({ siteName: 'Saved name', countryCode: 'US' });
});
