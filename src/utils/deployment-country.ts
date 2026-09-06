/** Runtime assertion only: country business settings still belong to the CMS. */
export function deploymentCountryCode(): string | null {
  const code = process.env.DEPLOYMENT_COUNTRY_CODE?.trim().toUpperCase();
  if (!code && process.env.NODE_ENV !== 'production') return null;
  if (!code || !/^[A-Z]{2}$/.test(code)) {
    throw new Error('DEPLOYMENT_COUNTRY_CODE must identify this production deployment');
  }
  return code;
}

export function assertDeploymentCountry(countryCode: string): void {
  const expected = deploymentCountryCode();
  if (expected && expected !== countryCode) {
    throw new Error(`Deployment country ${expected} does not match CMS country ${countryCode}`);
  }
}
