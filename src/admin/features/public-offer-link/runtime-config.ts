export const ADMIN_RUNTIME_CONFIG_PATH = '/admin-runtime-config';

type AdminGet = (path: string) => Promise<unknown>;

let cachedRequest: Promise<string | null> | null = null;

export function unwrapRuntimePublicSiteUrl(response: unknown): string | null {
  const value = (response as any)?.data?.data?.publicSiteUrl;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Load once per admin-page lifetime. Content Manager renders one action per
 * table row, so a module-level request cache prevents a list from issuing the
 * same runtime-config request hundreds of times. A failed request is evicted
 * so the next click can retry after a transient network error.
 */
export function loadRuntimePublicSiteUrl(get: AdminGet): Promise<string | null> {
  if (!cachedRequest) {
    cachedRequest = get(ADMIN_RUNTIME_CONFIG_PATH)
      .then(unwrapRuntimePublicSiteUrl)
      .catch((error) => {
        cachedRequest = null;
        throw error;
      });
  }
  return cachedRequest;
}

export function clearRuntimePublicSiteUrlCache(): void {
  cachedRequest = null;
}
