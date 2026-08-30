// Client for the /translation admin endpoints (registerTranslationRoutes).
export type LocaleTranslationStatus = {
  locale: string;
  localeName: string;
  state: 'missing' | 'synced' | 'stale' | 'in-progress' | 'failed';
  needsReview: boolean;
  reviewNotes: string | null;
  translatedAt: string | null;
  lastError: string | null;
};

export type EntryTranslationStatus = {
  enabled: boolean;
  locales: LocaleTranslationStatus[];
};

export function unwrapEntryStatus(response: unknown): EntryTranslationStatus {
  const value: any =
    (response as any)?.data?.data ?? (response as any)?.data ?? response;
  if (!value || typeof value !== 'object' || !Array.isArray(value.locales)) {
    throw new Error('Translation status returned an unexpected response.');
  }
  return value as EntryTranslationStatus;
}

export function translationError(error: any): string {
  return (
    error?.response?.data?.error?.message ??
    (typeof error?.response?.data?.error === 'string'
      ? error.response.data.error
      : undefined) ??
    error?.message ??
    'Translation request failed.'
  );
}
