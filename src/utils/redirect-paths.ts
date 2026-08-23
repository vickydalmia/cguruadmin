// Path parsing and canonical keys for the redirect validator: the
// comparison forms every other redirect module builds on. Pure string
// transforms, no Strapi access. Split out of redirect-validation.ts, which
// keeps the write orchestration.

/**
 * The canonical comparison form of a request path: trimmed, query/hash
 * removed, duplicate slashes collapsed, leading slash forced, trailing slash
 * dropped. `/Winter-Sale/`, `winter-sale` and `//winter-sale?utm=x` all
 * normalise to `/winter-sale`.
 *
 * Returns '' only for input that is not a string or is blank.
 */
export function normalizeRedirectPath(value: unknown): string {
  if (typeof value !== 'string') return '';

  let path = value.trim();
  if (!path) return '';

  const marker = path.search(/[?#]/);
  if (marker !== -1) path = path.slice(0, marker);

  path = path.replace(/\/{2,}/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');

  return path || '/';
}

/**
 * Fold an already-normalized path into its matching key. MUST stay
 * byte-equivalent with foldPathKey() in
 * cguru-ui/src/features/routing/api/get-redirects.ts — the validator's cycle
 * and duplicate detection and the resolver's walk have to agree on what counts
 * as "the same URL", or a chain the admin proved acyclic could still loop at
 * read time.
 *
 * The middleware hands the resolver the request path in WIRE form
 * (percent-encoded), while an editor authors `from` in whichever form they
 * pasted — so `/café` and `/caf%C3%A9` must produce one key. Steps, in order
 * (only the order is load-bearing; both sides of every comparison run the
 * same steps):
 *
 *  1. decode percent-escapes of NON-ASCII bytes only (`%C3%A9` → `é`). A
 *     sequence that is not valid UTF-8 (a malformed `%c3` with no
 *     continuation byte) is left exactly as authored instead of throwing.
 *     ASCII escapes are deliberately NOT decoded: `%2F` as a path byte is
 *     data, not a segment separator, and `%20` cannot be authored unescaped —
 *     decoding either would change which paths are "the same".
 *  2. NFC-normalise and lowercase, so composed/decomposed/uppercase `é` fold
 *     to one character.
 *  3. re-encode the non-ASCII characters back to wire form and lowercase the
 *     result, folding hex-digit casing (`%C3%A9` vs `%c3%a9`).
 */
export function foldPathKey(path: string): string {
  const decoded = path.replace(/(?:%[89a-f][0-9a-f])+/gi, (sequence) => {
    try {
      return decodeURIComponent(sequence);
    } catch {
      return sequence; // not valid UTF-8 — compare the raw bytes as authored
    }
  });

  const folded = decoded.normalize('NFC').toLowerCase();

  try {
    return folded
      .replace(/[\u{80}-\u{10ffff}]/gu, (char) => encodeURIComponent(char))
      .toLowerCase();
  } catch {
    return folded; // lone surrogate — unencodable, and unmatchable either way
  }
}

/**
 * Matching key. Case-FOLDED, unlike entity slugs.
 *
 * Folding is safe here in a way it is not for entity routes: an entity match
 * decides who serves 200, so folding it would serve the same page at every
 * casing and split PageRank. A redirect only ever produces a 3xx, so folding
 * `from` costs nothing and stops `/Winter-Sale` and `/winter-sale` from being
 * two rows that disagree about where the URL goes. Percent-encoding of
 * non-ASCII characters is folded too (see foldPathKey) so an authored `/café`
 * matches the wire-form request `/caf%C3%A9`.
 */
export function redirectKey(value: unknown): string {
  return foldPathKey(normalizeRedirectPath(value));
}

/**
 * A `from` path whose every character is already wire-safe: the unreserved set
 * A-Za-z0-9-._~/ plus already-percent-encoded %XX bytes. MUST stay in step
 * with the `from` regex in
 * src/api/redirect/content-types/redirect/schema.json.
 *
 * WHY THIS IS TIGHTER THAN "no whitespace" (F5)
 * ---------------------------------------------
 * The frontend matches a request against `from` by its FOLDED wire form, and a
 * browser sends every character outside the unreserved set percent-encoded: an
 * apostrophe as `%27`, a space as `%20`, a parenthesis as `%28`/`%29`, an
 * accented letter as `%C3%A9`. An authored `/men's` therefore never matches the
 * request `/men%27s`, and the redirect silently never fires. Requiring `from`
 * to already be in wire form — unreserved characters or `%XX` escapes only —
 * makes what the editor saves exactly what the request carries. An author who
 * wants the accented URL writes `/caf%C3%A9`, not `/café`; both then match,
 * because the fold decodes and re-encodes the non-ASCII escape. Whitespace,
 * apostrophes, parentheses and commas are all rejected here, matching the
 * `from` regex in the content-type schema.
 */
const WIRE_SAFE_FROM = /^\/(?:[A-Za-z0-9._~/-]|%[0-9A-Fa-f]{2})*$/;

export function isWireSafeFromPath(path: string): boolean {
  return WIRE_SAFE_FROM.test(path);
}

/**
 * A `from` path that is unambiguously a build asset: anything under the
 * hashed-bundle namespace `/_astro/`, or ending in an asset extension. The ISR
 * gateway serves static assets BEFORE the redirect map is consulted, so such a
 * rule saves cleanly but never fires — a silent no-op an editor cannot debug.
 *
 * Deliberately NOT rejected: document-ish extensions (`.html`, `.php`, `.xml`,
 * `.txt`, …). This is a WordPress-migrated site, so legacy `/old-page.html`
 * style redirect sources are legitimate and common — only extensions no page
 * URL ever carries are listed here.
 */
const ASSET_FROM_PREFIX = '/_astro/';
const ASSET_FROM_EXTENSION =
  /\.(?:ico|css|js|mjs|map|png|jpg|jpeg|webp|avif|gif|svg|woff|woff2|ttf|otf|eot)$/i;

export function isAssetFromPath(path: string): boolean {
  return (
    path.toLowerCase().startsWith(ASSET_FROM_PREFIX) || ASSET_FROM_EXTENSION.test(path)
  );
}
