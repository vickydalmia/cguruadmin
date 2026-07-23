/**
 * `<br>`-joined visual lines → one block per line.
 *
 * WP-migrated content (and anything pasted out of Word / a WP editor) joins
 * visual lines with `<br>` inside ONE block, so a heading or list — both
 * block-level formats — applies to every line in that block at once: the
 * reported "H2 on the first line makes every line H2". Splitting each block on
 * `<br>` into separate paragraphs/headings means one visual line = one block
 * and per-line formatting behaves the way editors expect.
 *
 * Deliberately NOT a substitute for disabling `hardBreak`: Shift+Enter stays
 * available and nothing rewrites the document while it is being edited. This
 * runs only at the two points where markup enters the document from outside —
 * initial/external load and paste. (A soft break that was saved and later
 * reloaded does get split, which is the long-standing load-time behaviour
 * legacy stored content still depends on.)
 *
 * The DOM parser is injectable because the admin's vitest project runs in the
 * `node` environment (see vitest.config.ts) where `DOMParser` does not exist,
 * and adding a DOM test environment is out of scope. Callers in the admin
 * bundle get the browser parser from the default argument; the pure helpers
 * below carry the logic that is worth asserting on and are tested directly.
 */

/** Parses an HTML fragment and returns the document holding it in `body`. */
export type HtmlParser = (html: string) => Document | null;

/** Blocks whose `<br>`s become sibling blocks of the same tag. */
const SPLITTABLE_BLOCKS = 'p,h1,h2,h3,h4,h5,h6';

/** Any block wrapper — used only to detect loose, unwrapped `<br>` text. */
const BLOCK_WRAPPERS = 'p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,table,pre';

/**
 * Cheap pre-check so untouched content skips a parse/serialise round-trip
 * entirely — important on paste, which runs on every Cmd+V.
 */
export function containsBreak(html: string): boolean {
  return Boolean(html) && /<br/i.test(html);
}

/**
 * Splits a block's children into the runs that sit between its `<br>`s.
 * Always returns at least one group, so a block with no `<br>` yields exactly
 * one run and is rebuilt unchanged.
 */
export function groupNodesByBreak<T extends { nodeName: string }>(
  nodes: readonly T[]
): T[][] {
  const groups: T[][] = [[]];
  for (const node of nodes) {
    if (node.nodeName === 'BR') groups.push([]);
    else groups[groups.length - 1].push(node);
  }
  return groups;
}

/**
 * Drops the empty runs that consecutive `<br>`s produce, while keeping a run
 * that carries an image (visually a line, textually empty).
 */
export function isMeaningfulBlock(
  text: string | null | undefined,
  hasImage: boolean
): boolean {
  return (text ?? '').trim() !== '' || hasImage;
}

/** Browser parser, or null when there is no DOM (server/test). */
export function defaultHtmlParser(): HtmlParser | null {
  if (typeof DOMParser === 'undefined') return null;
  return (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

export function normalizeBreaksToBlocks(
  html: string,
  parseHtml: HtmlParser | null = defaultHtmlParser()
): string {
  if (!containsBreak(html)) return html;
  if (!parseHtml) return html;

  const doc = parseHtml(html);
  if (!doc?.body) return html;
  const body = doc.body;

  // Loose <br>-separated text with no block wrapper → wrap so the split applies.
  if (!body.querySelector(BLOCK_WRAPPERS)) {
    const p = doc.createElement('p');
    while (body.firstChild) p.appendChild(body.firstChild);
    body.appendChild(p);
  }

  body.querySelectorAll(SPLITTABLE_BLOCKS).forEach((block) => {
    if (!block.querySelector('br')) return;
    const tag = block.tagName.toLowerCase();

    const groups = groupNodesByBreak(Array.from(block.childNodes));

    // One new same-tag block per run; drop empty runs (from consecutive <br>).
    const out: HTMLElement[] = [];
    for (const group of groups) {
      const el = doc.createElement(tag);
      group.forEach((node) => el.appendChild(node.cloneNode(true)));
      if (isMeaningfulBlock(el.textContent, Boolean(el.querySelector('img')))) {
        out.push(el);
      }
    }
    if (out.length) block.replaceWith(...out);
  });

  return body.innerHTML;
}
