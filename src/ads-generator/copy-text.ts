// Small text helpers shared by the mechanical (./validate-creative.ts) and
// editorial (./validate-editorial.ts) copy checks.

const NUMBER = /\d+(?:[.,]\d+)*/g;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Brand names can contain digits ("VK1", "7Eleven"); remove the brand before reading numbers. */
export function withoutBrand(text: string, brandName: string): string {
  return text.split(new RegExp(escapeRegExp(brandName), 'gi')).join(' ');
}

/** "1,499 and 40%" → ["1499", "40"]. */
export function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((value) => value.replace(/,/g, ''));
}

/**
 * Whole-word, case-insensitive phrase match ("ends" does not match "trends").
 * Symbol terms such as "+" match anywhere.
 */
export function termPattern(term: string): RegExp {
  const body = escapeRegExp(term).replace(/ /g, '\\s+');
  return /^\w/.test(term) ? new RegExp(`\\b${body}\\b`, 'i') : new RegExp(body, 'i');
}

export function hasAnyTerm(text: string, terms: readonly string[]): string | undefined {
  return terms.find((term) => termPattern(term).test(text));
}
