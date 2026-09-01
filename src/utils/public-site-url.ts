import { getDomain } from 'tldts-icann';

/**
 * Normalize the storefront origin configured on the running Strapi process.
 *
 * The value is deployment identity rather than CMS content: one immutable
 * image can therefore serve every country while each container supplies its
 * own PUBLIC_SITE_URL. Paths, queries and fragments are deliberately removed
 * because public entry links are always rooted at the storefront origin.
 */
export function normalizePublicSiteUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;

  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function configuredPublicSiteUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  return normalizePublicSiteUrl(environment.PUBLIC_SITE_URL);
}

export function configuredPublicSiteDomain(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const siteUrl = configuredPublicSiteUrl(environment);
  if (!siteUrl) return null;

  const hostname = new URL(siteUrl).hostname.toLowerCase();
  return getDomain(hostname) ?? hostname;
}
