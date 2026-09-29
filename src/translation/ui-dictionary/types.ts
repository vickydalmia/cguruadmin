// Shared shapes of the UI-text dictionary: catalogue/translation rows as the
// store reads them, and the results the content API, the translation job
// (B2) and the admin page (B3) consume.

export type TranslationOrigin = 'ai' | 'manual';

/** One pushed catalogue entry (the storefront's flattened English). */
export type CatalogueEntryInput = {
  text: string;
  description?: string;
  maxLength?: number;
  pluralOf?: string;
};

export type CatalogueSyncInput = {
  version: string;
  entries: Record<string, CatalogueEntryInput>;
};

export type CatalogueRow = {
  key: string;
  text: string;
  description: string | null;
  maxLength: number | null;
  pluralOf: string | null;
  hash: string;
  overrideText: string | null;
  effectiveHash: string;
  overrideUpdatedBy: number | null;
  overrideUpdatedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  removedAt: string | null;
};

export type TranslationRow = {
  locale: string;
  key: string;
  text: string;
  sourceHash: string;
  origin: TranslationOrigin;
  updatedBy: number | null;
  updatedAt: string | null;
};

export type UiCatalogueMeta = {
  version: string;
  pushedAt: string;
  counts: { total: number; added: number; changed: number; removed: number };
};

export type CatalogueSyncResult = {
  unchanged: boolean;
  added: number;
  changed: number;
  removed: number;
  /** Keys whose translations need (re)work: added + changed + revived. */
  touchedKeys: string[];
  version: string;
};

/**
 * Per-locale row status. Non-English: `missing` (no row), `stale` (row made
 * from an older English source), else the row's origin. English: `source`
 * (pushed text shown) or `override` (admin text shown).
 */
export type EntryStatus =
  | 'missing'
  | 'stale'
  | 'ai'
  | 'manual'
  | 'source'
  | 'override';

export type UiDictionaryEntry = {
  key: string;
  locale: string;
  source: {
    /** Pushed English. For a plural expansion row: the base's `other` text. */
    text: string;
    overrideText: string | null;
    /** What the UI shows in English and what the AI translates from. */
    effectiveText: string;
    effectiveHash: string;
    description: string | null;
    maxLength: number | null;
    pluralOf: string | null;
    /** Set on plural rows (pushed or expanded): the CLDR category. */
    pluralCategory: string | null;
    /** True for a category the locale needs but English never pushes. */
    expanded: boolean;
    removedAt: string | null;
    /** Last English-override write (the English tab's "Updated" column). */
    overrideUpdatedBy: number | null;
    overrideUpdatedAt: string | null;
  };
  translation: {
    text: string;
    origin: TranslationOrigin;
    sourceHash: string;
    updatedBy: number | null;
    updatedAt: string | null;
  } | null;
  status: EntryStatus;
};

/** One unit of work for the dictionary translation job (B2). */
export type UiDictionaryPendingLeaf = {
  key: string;
  /** Effective English (override ?? pushed text). */
  text: string;
  /** The catalogue hash to store as `source_hash` once translated. */
  sourceHash: string;
  maxLength: number | null;
  description: string | null;
  /** Extra guidance for the translator (plural category hint), if any. */
  note: string | null;
};

export type AiTranslationWrite = {
  key: string;
  text: string;
  /** The `sourceHash` of the pending leaf this text was produced for. */
  sourceHash: string;
};

export type AiTranslationWriteResult = {
  /** Rows inserted or updated. */
  written: number;
  /** Keys dropped before writing: the English source moved since translation. */
  staleDropped: string[];
  /** Keys whose current manual translation the merge guard preserved. */
  guarded: number;
};

export type ImportMessagesResult = {
  written: number;
  skipped: Array<{ key: string; reason: string }>;
};

export type UiDictionarySummary = {
  catalogue: { total: number; overridden: number; removed: number };
  locales: Record<
    string,
    { translated: number; ai: number; manual: number; stale: number; missing: number }
  >;
};

export type PublicDictionary = {
  ready: boolean;
  locale: string;
  version: string | null;
  updatedAt: string | null;
  messages: Record<string, string>;
};
