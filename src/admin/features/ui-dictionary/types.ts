// Shapes of the /ui-dictionary admin endpoints (registerUiDictionaryRoutes).
// Entry rows are the server's own type; the status envelope mirrors
// UiDictionaryStatus in src/translation/ui-dictionary/admin-service.ts.
import type {
  EntryStatus,
  UiCatalogueMeta,
  UiDictionaryEntry,
  UiDictionarySummary,
} from '../../../translation/ui-dictionary/types';

export type { EntryStatus, UiCatalogueMeta, UiDictionaryEntry, UiDictionarySummary };

export const ENGLISH_CODE = 'en';

export type UiLanguage = {
  code: string;
  name: string;
  nativeName: string;
  dir: 'ltr' | 'rtl';
};

export type UiJobState = {
  status: string;
  attemptCount: number;
  lastError: string | null;
} | null;

export type UiDictionaryStatus = {
  translationActive: boolean;
  languages: UiLanguage[];
  catalogue: UiCatalogueMeta | null;
  perLocale: UiDictionarySummary;
  jobs: Record<string, UiJobState> | null;
};

export type ImportResult = {
  locale: string;
  written: number;
  skipped: Array<{ key: string; reason: string }>;
  jobs: string[];
};

export type ExportPayload = {
  locale: string;
  messages: Record<string, string>;
};

/** URL state of the page — every filter is shareable and survives a refresh. */
export type UiDictionaryQuery = {
  locale?: string;
  status?: string;
  namespace?: string;
  removed?: string;
  _q?: string;
};
