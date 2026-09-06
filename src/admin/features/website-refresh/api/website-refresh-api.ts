import type { useFetchClient } from '@strapi/strapi/admin';
type Client = ReturnType<typeof useFetchClient>;
export type RefreshOptions = { country: string; languages: { code: string; name: string; pathPrefix: string }[]; paths: string[] };
export type RefreshPageDiagnostic = {
  path: string; state: string; generatedAt: string | null; cachedHttpStatus: number | null;
  targetVersion: number | null; renderedVersion: number | null; jobId: string | null;
  attemptsMade: number | null; maxAttempts: number | null;
  lastAttemptAt: string | null; finishedAt: string | null; error: string | null;
};
export type RefreshStatus = {
  id: string; state: string; message: string; requestedAt?: string; acceptedAt?: string;
  checkedAt?: string; attempts?: number; nextRetryAt?: string | null;
  deliveryError?: string | null; statusError?: string | null; deliveryKey?: string | null;
  pages?: RefreshPageDiagnostic[]; removedPaths?: string[];
};
export function websiteRefreshApi(client: Client) {
  return {
    async options(uid?: string, documentId?: string): Promise<RefreshOptions> {
      return (await client.get('/website-refresh/options', { params: { uid, documentId } })).data;
    },
    async refresh(input: { locale: string; all: boolean; path?: string; confirm?: boolean }): Promise<RefreshStatus> {
      return (await client.post('/website-refresh/refresh', input)).data;
    },
    async status(id: string): Promise<RefreshStatus> {
      return (await client.get(`/website-refresh/status/${encodeURIComponent(id)}`)).data;
    },
  };
}
export function refreshError(error: unknown): string {
  const value = error as { response?: { status?: number; data?: { error?: string | { message?: string } } } };
  if (value.response?.status === 403) return 'Your role needs the “Refresh website cache” permission.';
  const detail = value.response?.data?.error;
  return (typeof detail === 'string' ? detail : detail?.message) || 'Unable to contact the refresh service. Please try again.';
}
