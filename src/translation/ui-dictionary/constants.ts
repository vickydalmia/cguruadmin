// Storefront UI-text dictionary: the constants every layer (schema, store,
// enqueue, content API, admin routes) agrees on. Import-free.

/** Synthetic outbox identity: the dictionary job is `ui-dictionary:catalogue:<locale>`. */
export const UI_DICTIONARY_UID = 'ui-dictionary';
export const UI_DICTIONARY_DOCUMENT_ID = 'catalogue';

export const UI_CATALOGUE_TABLE = 'ui_catalogue';
export const UI_TRANSLATIONS_TABLE = 'ui_translations';

/** core_store slot for the catalogue meta (version, pushedAt, counts). */
export const UI_DICTIONARY_STORE = {
  type: 'plugin',
  name: 'ui-dictionary',
  key: 'catalogue',
} as const;

export const MAX_CATALOGUE_KEYS = 5_000;
export const MAX_KEY_LENGTH = 255;
export const MAX_TEXT_LENGTH = 2_000;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_BODY_BYTES = 1_048_576;

/**
 * Keys per LLM call in the dictionary translation job. `translateEntryLeaves`
 * is all-or-nothing per call, so a group is also the unit of persistence: a
 * failed group never discards the groups delivered before it.
 */
export const UI_DICTIONARY_GROUP_SIZE = 80;

/** `namespace.key` or deeper; camelCase segments after the first dot. */
export const UI_DICTIONARY_KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** CLDR plural categories, in CLDR order. */
export const PLURAL_CATEGORIES = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

export function isPluralCategory(value: string): value is PluralCategory {
  return (PLURAL_CATEGORIES as readonly string[]).includes(value);
}

/** Advisory-lock names (hashed with `hashtext`) serialising the writers. */
export const CATALOGUE_LOCK_NAME = 'ui-dictionary:catalogue';
export function localeLockName(locale: string): string {
  return `ui-dictionary:${locale}`;
}

/** The reason on the coalesced ISR sweep every dictionary write requests. */
export const UI_DICTIONARY_SWEEP_REASON = 'ui-dictionary';
