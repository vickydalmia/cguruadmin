// The built-in CONTENT LOCALE TABLE — zero imports on purpose: consumed by
// both the translation registry and site-configuration's public payload
// builder, which sit on opposite sides of an import cycle otherwise.
//
// Adding a language later (Hindi, Tamil, …) is ONE data row here plus its
// prompt file (and optional glossary) under ../prompts — no new code paths.
// A site opts in per locale through Country Setup (`translationEnabled` +
// `translationLocales`).
export type ContentLocale = {
  /** Bare content-locale code — also the Strapi locale and the URL prefix. */
  code: string;
  /** English display name for logs and the admin panel. */
  name: string;
  /** Native display name for a storefront language switcher. */
  nativeName: string;
  dir: 'ltr' | 'rtl';
  /** og:locale value for pages rendered in this locale. */
  ogLocale: string;
  /** Prompt template under src/translation/locales/prompts/<file>. */
  promptFile: string;
  /** Independent native-editor pass run after the first translation. */
  editorPromptFile: string;
  /** Optional glossary under src/translation/locales/glossaries/<file>. */
  glossaryFile?: string;
};

export const CONTENT_LOCALE_REGISTRY: readonly ContentLocale[] = [
  {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    dir: 'rtl',
    ogLocale: 'ar_AE',
    promptFile: 'ar.md',
    editorPromptFile: 'ar-editor.md',
    glossaryFile: 'ar.md',
  },
] as const;

export function contentLocaleByCode(code: string): ContentLocale | undefined {
  return CONTENT_LOCALE_REGISTRY.find((locale) => locale.code === code);
}

export function supportedContentLocaleCodes(): string[] {
  return CONTENT_LOCALE_REGISTRY.map((locale) => locale.code);
}
