import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDeploymentCountry, deploymentCountryCode } from './deployment-country';
afterEach(() => vi.unstubAllEnvs());
describe('deployment identity', () => {
  it.each(['IN', 'US', 'AE'])('accepts matching %s and rejects a different database', (country) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEPLOYMENT_COUNTRY_CODE', country);
    expect(() => assertDeploymentCountry(country)).not.toThrow();
    expect(() => assertDeploymentCountry(country === 'IN' ? 'AE' : 'IN')).toThrow('does not match');
  });
  it('requires explicit identity in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEPLOYMENT_COUNTRY_CODE', '');
    expect(deploymentCountryCode).toThrow();
  });
});
