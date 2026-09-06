// CONTENT-LOCALE RESOLVER: turns an admin-picked ISO 639-1 code into
// everything the pipeline and the storefront need (English + native names,
// direction, script, og:locale) using the runtime's ICU data. Import-free
// except for the two data tables so site-configuration's payload builder can
// use it without dragging `strapi` into the module graph.
//
// v1 accepts bare two-letter codes only: the code is also the Strapi locale
// and the storefront URL prefix. `en` is the source language on every
// deployment and is never resolvable as a TARGET.
import { ISO_639_1_CODES } from './iso-639-1';
import { contentLocaleOverride } from './table';

export type ContentLocale = {
  /** Bare content-locale code — also the Strapi locale and the URL prefix. */
  code: string;
  /** English display name for prompts, logs and the admin panel. */
  name: string;
  /** Native display name for a storefront language switcher. */
  nativeName: string;
  dir: 'ltr' | 'rtl';
  /** og:locale value for pages rendered in this locale (`code_COUNTRY`). */
  ogLocale: string;
  /** CLDR script code from ICU likely-subtags (Arab, Deva, Hans, …) or null. */
  script: string | null;
  countryCode: string;
  countryName: string;
  promptFile?: string;
  editorPromptFile?: string;
  glossaryFile?: string;
};

export type ContentLocaleSite = {
  countryCode: string;
  countryName: string;
};

const ISO_CODES = new Set<string>(ISO_639_1_CODES);
const SOURCE_LOCALE = 'en';

/** Last resort when the runtime exposes neither textInfo API. */
const RTL_FALLBACK = new Set([
  'ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'ckb', 'dv', 'ks', 'ae',
]);

/**
 * CLDR script codes that are not Unicode `Script=` property values; mapped
 * to the Unicode scripts a text in that language is actually written in.
 */
const CLDR_TO_UNICODE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  Hans: ['Han'],
  Hant: ['Han'],
  Jpan: ['Han', 'Hiragana', 'Katakana'],
  Kore: ['Hangul', 'Han'],
};

/**
 * Scripts that cannot tell a translation from its English source: Latin
 * (English is Latin too) and the CLDR pseudo-scripts Unknown/Common/Inherited.
 */
const NON_DISCRIMINATING_SCRIPTS = new Set(['Latn', 'Zzzz', 'Zyyy', 'Zinh']);

function canonicalCode(code: unknown): string | null {
  const trimmed = String(code ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(trimmed) ? trimmed : null;
}

let englishNames: Intl.DisplayNames | null | undefined;

function englishDisplayNames(): Intl.DisplayNames | null {
  if (englishNames !== undefined) return englishNames;
  try {
    englishNames = new Intl.DisplayNames(['en'], {
      type: 'language',
      fallback: 'none',
    });
  } catch {
    englishNames = null;
  }
  return englishNames;
}

/** English language name per ICU, or null when ICU cannot name the code. */
export function englishLanguageName(code: string): string | null {
  try {
    return englishDisplayNames()?.of(code) ?? null;
  } catch {
    return null;
  }
}

function nativeLanguageName(code: string, englishName: string): string {
  try {
    return (
      new Intl.DisplayNames([code], { type: 'language', fallback: 'none' }).of(
        code,
      ) ?? englishName
    );
  } catch {
    return englishName;
  }
}

function scriptFor(code: string): string | null {
  try {
    return new Intl.Locale(code).maximize().script ?? null;
  } catch {
    return null;
  }
}

/**
 * Text direction per ICU. Node 22 exposes only the `textInfo` getter; newer
 * runtimes ship `getTextInfo()` (and deprecate the getter) — feature-detect
 * both before falling back to the static RTL set.
 */
export function textDirectionFor(code: string): 'ltr' | 'rtl' {
  try {
    const locale = new Intl.Locale(code) as unknown as {
      getTextInfo?: () => { direction?: string } | undefined;
      textInfo?: { direction?: string };
    };
    const info =
      typeof locale.getTextInfo === 'function'
        ? locale.getTextInfo()
        : locale.textInfo;
    if (info?.direction === 'rtl' || info?.direction === 'ltr') {
      return info.direction;
    }
  } catch {
    // fall through to the static set
  }
  return RTL_FALLBACK.has(code) ? 'rtl' : 'ltr';
}

/**
 * A RegExp matching one character of the language's script, for the
 * "target language missing" output check. Null for Latin-script languages
 * (English prose is Latin too, so the check would be meaningless) and for
 * anything the runtime's regex engine cannot express.
 */
export function unicodeScriptPattern(script: string | null): RegExp | null {
  if (!script || NON_DISCRIMINATING_SCRIPTS.has(script)) return null;
  const names = CLDR_TO_UNICODE_SCRIPTS[script] ?? [script];
  try {
    return new RegExp(names.map((name) => `\\p{Script=${name}}`).join('|'), 'u');
  } catch {
    return null;
  }
}

/**
 * True when `code` is a bare ISO 639-1 code ICU can name, other than the
 * English source. The admin multi-select offers exactly this set.
 */
export function isResolvableContentLocale(code: unknown): boolean {
  const canonical = canonicalCode(code);
  return (
    canonical !== null &&
    canonical !== SOURCE_LOCALE &&
    ISO_CODES.has(canonical) &&
    englishLanguageName(canonical) !== null
  );
}

export function resolveContentLocale(
  code: unknown,
  site: ContentLocaleSite,
): ContentLocale | null {
  const canonical = canonicalCode(code);
  if (canonical === null || !isResolvableContentLocale(canonical)) return null;
  const name = englishLanguageName(canonical) as string;
  const countryCode = String(site.countryCode ?? '').trim().toUpperCase();
  return {
    code: canonical,
    name,
    nativeName: nativeLanguageName(canonical, name),
    dir: textDirectionFor(canonical),
    ogLocale: `${canonical}_${countryCode}`,
    script: scriptFor(canonical),
    countryCode,
    countryName: String(site.countryName ?? '').trim(),
    ...contentLocaleOverride(canonical),
  };
}

/** Every language the admin may pick for `site`, sorted by English name. */
export function selectableContentLocales(
  site: ContentLocaleSite,
): ContentLocale[] {
  return ISO_639_1_CODES.map((code) => resolveContentLocale(code, site))
    .filter((locale): locale is ContentLocale => locale !== null)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
