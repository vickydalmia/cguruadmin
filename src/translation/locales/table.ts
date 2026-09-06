// Per-language PROMPT OVERRIDES — zero imports on purpose: consumed by the
// resolver, which site-configuration's public payload builder also reads.
//
// A language does NOT need a row here to be translatable: any ISO 639-1
// code the admin picks in Country Setup renders the generic
// ../prompts/default.md / default-editor.md templates. A row exists only
// when a language has hand-tuned prompt files (and optionally a glossary)
// under src/translation/locales/prompts|glossaries/. The `ar` files are
// hashed into every stored Arabic translation (prompt fingerprint) and must
// stay byte-identical — see prompts.test.ts.
export type ContentLocaleOverride = {
  /** Prompt template under src/translation/locales/prompts/<file>. */
  promptFile?: string;
  /** Independent native-editor pass run after the first translation. */
  editorPromptFile?: string;
  /** Optional glossary under src/translation/locales/glossaries/<file>. */
  glossaryFile?: string;
};

export const CONTENT_LOCALE_OVERRIDES: Readonly<
  Record<string, ContentLocaleOverride>
> = {
  ar: {
    promptFile: 'ar.md',
    editorPromptFile: 'ar-editor.md',
    glossaryFile: 'ar.md',
  },
};

export function contentLocaleOverride(
  code: string,
): ContentLocaleOverride | undefined {
  return Object.prototype.hasOwnProperty.call(CONTENT_LOCALE_OVERRIDES, code)
    ? CONTENT_LOCALE_OVERRIDES[code]
    : undefined;
}
