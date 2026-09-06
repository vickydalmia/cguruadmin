// Read state of the UI Text screen. Every filter lives in the URL (a
// filtered tab is shareable and survives a refresh); status loads once per
// reload token, entries per selected language, and both poll every 8 s
// while a dictionary job for that language is pending or processing.
import * as React from 'react';
import { useFetchClient, useQueryParams } from '@strapi/strapi/admin';

import {
  entriesPath,
  isPermissionError,
  parseSearch,
  statusPath,
  uiDictionaryError,
  unwrapEntries,
  unwrapStatus,
} from './api';
import type { EntryFilters } from './filter-entries';
import {
  ENGLISH_CODE,
  type UiDictionaryEntry,
  type UiDictionaryQuery,
  type UiDictionaryStatus,
  type UiLanguage,
} from './types';

export const POLL_INTERVAL_MS = 8_000;

const ENGLISH: UiLanguage = { code: ENGLISH_CODE, name: 'English', nativeName: 'English', dir: 'ltr' };

export function isJobRunning(status: UiDictionaryStatus | null, locale: string): boolean {
  const job = status?.jobs?.[locale];
  return job?.status === 'pending' || job?.status === 'processing';
}

/**
 * Jobs are per target language but are started from ANY tab ("Translate all
 * languages" and English-override saves run from the English tab, which has
 * no job of its own), so polling watches all of them.
 */
export function anyJobRunning(status: UiDictionaryStatus | null): boolean {
  return Object.keys(status?.jobs ?? {}).some((code) => isJobRunning(status, code));
}

export function useUiDictionary() {
  const { get } = useFetchClient();
  const [{ query }, setQuery] = useQueryParams<UiDictionaryQuery>({});

  const [status, setStatus] = React.useState<UiDictionaryStatus | null>(null);
  const [entries, setEntries] = React.useState<UiDictionaryEntry[]>([]);
  const [statusLoading, setStatusLoading] = React.useState(true);
  const [entriesLoading, setEntriesLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [forbidden, setForbidden] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  const languages = status?.languages ?? [ENGLISH];
  const requested = typeof query.locale === 'string' ? query.locale : ENGLISH_CODE;
  // A language that was disabled since the URL was shared falls back to English.
  const language =
    languages.find((candidate) => candidate.code === requested) ??
    (status ? ENGLISH : { ...ENGLISH, code: requested });
  const locale = language.code;

  const filters: EntryFilters = {
    search: parseSearch(query._q),
    status: typeof query.status === 'string' ? query.status : '',
    namespace: typeof query.namespace === 'string' ? query.namespace : '',
    showRemoved: query.removed === '1',
  };

  React.useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    get(statusPath())
      .then((response) => {
        if (cancelled) return;
        setStatus(unwrapStatus(response));
        setError(null);
      })
      .catch((caught) => {
        if (cancelled) return;
        if (isPermissionError(caught)) setForbidden(true);
        else setError(uiDictionaryError(caught));
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [get, reloadToken]);

  React.useEffect(() => {
    let cancelled = false;
    setEntriesLoading(true);
    get(entriesPath(locale, filters.showRemoved))
      .then((response) => {
        if (!cancelled) setEntries(unwrapEntries(response));
      })
      .catch((caught) => {
        if (cancelled) return;
        if (isPermissionError(caught)) setForbidden(true);
        else setError(uiDictionaryError(caught));
        setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setEntriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [get, locale, filters.showRemoved, reloadToken]);

  const polling = anyJobRunning(status);
  React.useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => setReloadToken((token) => token + 1), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  const setLocale = (code: string) =>
    setQuery({ locale: code, status: '', namespace: '' });
  const setFilter = (next: Partial<Pick<UiDictionaryQuery, 'status' | 'namespace' | 'removed'>>) =>
    setQuery(next);
  const clearFilters = () => setQuery({ status: '', namespace: '', removed: '', _q: '' }, 'remove');

  return {
    status,
    languages,
    language,
    locale,
    entries,
    filters,
    loading: statusLoading || entriesLoading,
    error,
    forbidden,
    polling,
    setLocale,
    setFilter,
    clearFilters,
    reload: () => setReloadToken((token) => token + 1),
  };
}
