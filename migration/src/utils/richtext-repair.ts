/**
 * Decide whether a stored richtext value needs a structural repair.
 *
 * The WordPress theme stored several fields as `<font size="2"><p>…` with
 * neither tag closed. The public site injects these with `set:html`, and an
 * unclosed formatting element is re-created by the browser around every later
 * inline node on the page — one bad short description restyles the whole
 * document. Running the field through the allowlist drops such tags and
 * closes what is open.
 *
 * "Structural" is deliberate: sanitize-html also normalizes entities
 * (`&nbsp;` to U+00A0, `&` to `&amp;`). A clean row must not be rewritten for
 * that alone — byte changes feed the translation fingerprints, and a cosmetic
 * rewrite of every Arabic-translated entity would queue needless
 * retranslation. Compare the sequence of tag names instead: it changes only
 * when an element is dropped, added, or closed.
 */

/** The sequence of start/end tag names — the shape the browser will build. */
export function tagSignature(html: string): string {
  return (html.match(/<\/?[a-zA-Z][a-zA-Z0-9-]*/g) ?? [])
    .map((tag) => tag.toLowerCase())
    .join(" ");
}

/**
 * The repaired value, or null when the row should be left alone: nothing to
 * repair, only entity/attribute noise, or a value the allowlist reduces to
 * nothing (a required field is left for an editor rather than blanked).
 */
export function structuralRepair(
  stored: string,
  sanitize: (html: string) => string | null,
): string | null {
  const repaired = sanitize(stored);
  if (repaired === null || repaired === stored) return null;
  return tagSignature(repaired) === tagSignature(stored) ? null : repaired;
}
