/**
 * URL/filename slug generation, shared by the admin SlugInput (entity slugs)
 * and the upload extension (media filenames) so the two can't drift.
 *
 * Lives in src/constants/ because that is this repo's dependency-free layer:
 * the only place imported by BOTH the Node server bootstrap and the admin Vite
 * bundle (see the same rule on constants/*-sections.ts). It must stay pure —
 * no React, no DOM, no Node built-ins, no @strapi/* imports — or one of the two
 * builds breaks. It was briefly under src/admin/utils/, which made the server
 * depend on the admin tree; that direction is the one that bites when someone
 * later adds a browser-only import.
 *
 * The STEP ORDER below is the whole point of this module. The obvious
 * implementation — NFKD, then collapse [^a-z0-9]+ to '-' — mangles every
 * accented or symbol-bearing brand name, because NFKD is a *compatibility*
 * decomposition:
 *   - 'ä' splits into 'a' + a combining mark, and that mark, not being
 *     [a-z0-9], becomes a DASH mid-word ('Häagen-Dazs' -> 'ha-agen-dazs');
 *   - '™' expands into real letters that splice into the slug
 *     ('Sephora™' -> 'sephoratm'), and '½' into '1⁄2' ('½ Price' -> '1-2-price');
 *   - true ligatures like 'Æ' are not decomposed at all, so they are simply
 *     deleted ('Æon' -> 'on').
 * So: drop symbols first, expand ligatures by hand, and only then decompose
 * and DELETE (never dash) the combining marks.
 */

// Dropped outright rather than transliterated: symbols (™ © ® $ + €), format /
// invisible characters (ZWJ, soft hyphen, bidi marks), and "other numbers"
// (½ ¼ ² ①). All of them either expand into letters/digits under NFKD or are
// invisible to the editor who typed the name — neither belongs in a slug.
const DROPPED = /[\p{S}\p{Cf}\p{No}]/gu;

// Ligatures and stroked / dotless letters carry no combining mark, so NFKD
// leaves them whole and the [^a-z0-9] pass would delete them silently. Expand
// them to their conventional Latin equivalents first. Both cases are listed
// because this runs before the lowercase step (NFKD needs the marks stripped
// before casing, and casing 'İ' early would reintroduce one).
const EXPANDED: Record<string, string> = {
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ø: 'o',
  Ø: 'o',
  ß: 'ss',
  đ: 'd',
  Đ: 'd',
  ł: 'l',
  Ł: 'l',
  ı: 'i',
};
const EXPANDABLE = /[æÆœŒøØßđĐłŁı]/g;

// Combining Diacritical Marks only (U+0300–U+036F): the marks NFKD produces
// for Latin accents. Non-Latin scripts are left to the [^a-z0-9] pass, which
// drops them wholesale — deleting their marks first would just yield garbage.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

export function slugify(value: string): string {
  return value
    .replace(DROPPED, '')
    .replace(EXPANDABLE, (char) => EXPANDED[char])
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
