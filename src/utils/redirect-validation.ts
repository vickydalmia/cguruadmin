import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { IDENTITY_UIDS } from './identity-validation';
import {
  routeSlugCandidates,
  toRouteSlug,
  type IdentityKind,
} from './route-normalization';

/**
 * Write-time safety rules for the editor-managed `redirect` collection.
 *
 * WHY THIS FILE IS THE MOST DEFENSIVE VALIDATOR IN THE ADMIN
 * ----------------------------------------------------------
 * A redirect row is executed by cguru-ui/src/middleware.ts on EVERY request,
 * BEFORE routing, and it is authored by an editor with no code review and no
 * deploy gate. The three failure modes are all site-wide:
 *
 *  1. `from === to` — an unconditional self-redirect. The browser gives up
 *     after ~20 hops and the URL is dead for everyone.
 *  2. `from` equal to a LIVE entity slug — the redirect fires before the page
 *     renders, so a real store/brand/category/bank page becomes unreachable.
 *     Nothing else in the stack notices: the page still builds, the sitemap
 *     still lists it, and the route manifest still holds it. This is the
 *     single most important guard here.
 *  3. A cycle across SEVERAL rows (a→b, b→c, c→a). No single row looks wrong,
 *     which is exactly why it has to be caught at write time by walking the
 *     graph rather than by inspecting the row in isolation.
 *
 * The frontend resolver carries its own read-time cap (visited set, 5 hops,
 * return the last good hop) so a loop that somehow reaches production degrades
 * to an extra hop instead of a browser redirect loop. These write-time guards
 * are the primary defence; that cap is the backstop. Neither replaces the
 * other.
 *
 * GRANDFATHERING
 * --------------
 * Redirect rows go stale through no fault of their author: a redirect at
 * `/winter-sale` is legal today and starts shadowing a real page the moment
 * somebody creates a category with that slug. An editor who later opens that
 * row to fix its `note` must still be able to save. So every rule is gated on
 * the payload ACTUALLY CHANGING the field it protects:
 *
 *  - `from` is re-checked when `from` changes, or when the row is switched
 *    from inactive to active (flipping a shadowing redirect ON is the moment
 *    it starts breaking the site, and the editor demonstrably touched it).
 *  - `to` format is only reported when `to` changes. When `from` changes and
 *    the STORED `to` is unusable, the cross-field guards are skipped rather
 *    than blocking on a value this writer never saw.
 *  - An inactive row is exempt from the live-shadowing, duplicate and cycle
 *    guards entirely — it does not run.
 *
 * PARTIAL PAYLOADS
 * ----------------
 * `context.params.data` is partial on update. Nothing derives from the payload
 * alone: the stored document is read and the payload merged over it. A write
 * that touches none of from/to/active/statusCode returns before any query, so
 * an unrelated partial update never pays for this and never trips a stale row.
 */

export const REDIRECT_UID = 'api::redirect.redirect';

/**
 * Must equal MAX_REDIRECT_HOPS in
 * cguru-ui/src/features/routing/api/get-redirects.ts. What an editor can save
 * is then exactly what the resolver can follow to the end — a chain longer
 * than the resolver's budget would silently land the visitor on an
 * intermediate hop instead of the destination the editor authored.
 */
export const REDIRECT_MAX_HOPS = 5;

// Ceiling on active redirects, enforced at write (guard 2b) AND the bound on
// the cycle-walk graph load. It must not exceed what the frontend resolver can
// page in (MAX_REDIRECT_PAGES × 100 = 2000 in get-redirects.ts): a rule beyond
// that is saved but never executes and can hide a cycle from the walk. Redirect
// tables are small (tens to low hundreds) in practice; this only matters if one
// grows pathologically.
const ACTIVE_REDIRECT_LIMIT = 2000;
const ENTITY_CANDIDATE_LIMIT = 25;

const KIND_BY_UID: Record<string, IdentityKind> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};

/**
 * First path segments owned by a real page or internal namespace in
 * cguru-ui/src/pages/. A redirect `from` one of these shadows the route in
 * exactly the same way it shadows an entity — `/search` redirecting somewhere
 * takes site search offline.
 *
 * Duplicated from RESERVED_ROUTE_SEGMENTS in identity-validation.ts, which
 * does not export it. Keep the two lists in step when a page is added or
 * removed; both are derived from the same src/pages/ listing.
 * reserved-route-drift.test.ts parses both source files and fails when the
 * key sets diverge.
 */
const RESERVED_ROUTE_SEGMENTS = new Map<string, string>([
  ['404', 'the 404 page'],
  ['500', 'the 500 page'],
  ['about-us', 'the About Us page'],
  ['api', 'the internal API namespace'],
  ['banks', 'the bank listing page'],
  ['brands', 'the brand listing page'],
  ['careers', 'the careers pages'],
  ['categories', 'the category listing page'],
  ['coupon', 'the coupon detail pages'],
  ['deal', 'the deal detail pages'],
  ['error-pages', 'the error pages'],
  ['redeem-unavailable', 'the redeem fallback page'],
  ['robots.txt', 'the robots.txt route'],
  ['search', 'the search page'],
  ['sitemap.xml', 'the sitemap route'],
  ['stores', 'the store listing page'],
]);

type Problem = { path: string[]; message: string };

export function isRedirectUid(uid: string): boolean {
  return uid === REDIRECT_UID;
}

function readString(row: unknown, key: string): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = Reflect.get(row, key);
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(row: unknown, key: string): boolean | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = Reflect.get(row, key);
  return typeof value === 'boolean' ? value : undefined;
}

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
function foldPathKey(path: string): string {
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

export type RedirectTarget =
  | { kind: 'internal'; raw: string; path: string; key: string }
  | { kind: 'external'; raw: string }
  | { kind: 'invalid'; reason: string };

/**
 * Classify a `to` value. Deliberately strict about what may end up in a
 * Location header:
 *
 *  - `//evil.example` is rejected. Browsers read a leading `//` as
 *    protocol-relative, so it is an off-site redirect that LOOKS like a path —
 *    an open redirect an editor can create by typo.
 *  - Any backslash is rejected. WHATWG URL parsing folds `\` to `/` in
 *    http(s) contexts, so `/\evil.example` resolves to
 *    `https://evil.example/` — the same open redirect, spelled so it slips
 *    past a naive `//` check.
 *  - Anything that is neither an absolute http(s) URL nor a rooted path is
 *    rejected rather than guessed at.
 *  - Control characters are rejected: a raw CR/LF in a Location header is
 *    response splitting.
 */
export function classifyTarget(value: unknown): RedirectTarget {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { kind: 'invalid', reason: 'is empty' };

  // Escaped explicitly: a raw CR/LF reaching a Location header is response
  // splitting, and a literal control byte in the source is invisible in review.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return {
      kind: 'invalid',
      reason: 'contains a line break or control character, which is not allowed in a redirect target',
    };
  }

  // Before the external-URL branch: browsers treat "\" as "/" when resolving
  // a Location header, so a backslash target is an off-site redirect however
  // it is spelled ("/\evil.example" resolves to https://evil.example/).
  if (raw.includes('\\')) {
    return {
      kind: 'invalid',
      reason:
        `contains a backslash ("${raw}"). Browsers treat "\\" as "/", so this ` +
        `value would send visitors to a DIFFERENT site, not a page on this one. ` +
        `Use forward slashes only — "/path" for an internal page, or the full ` +
        `"https://…" address for an external one`,
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      new URL(raw);
    } catch {
      return { kind: 'invalid', reason: `is not a valid absolute URL ("${raw}")` };
    }
    return { kind: 'external', raw };
  }

  if (raw.startsWith('//')) {
    return {
      kind: 'invalid',
      reason:
        `starts with "//" ("${raw}"), which browsers read as a link to ANOTHER ` +
        `site, not a path on this one. Write "/${raw.replace(/^\/+/, '')}" for an ` +
        `internal page, or the full "https://…" address for an external one`,
    };
  }

  if (!raw.startsWith('/')) {
    return {
      kind: 'invalid',
      reason:
        `must be either a path on this site starting with "/" (for example ` +
        `"/nike/") or a full "https://…" address, but it is "${raw}"`,
    };
  }

  const path = normalizeRedirectPath(raw);
  return { kind: 'internal', raw, path, key: foldPathKey(path) };
}

/**
 * A live store/brand/category/bank whose public page is served at this path.
 *
 * Matching is case-insensitive (`$eqi`, an exact comparison — no LIKE
 * wildcards leak in) and re-confirmed in JS through toRouteSlug(), the same
 * normalisation the frontend uses to turn a stored "stores/amazon" into the
 * route "amazon". A raw string compare would miss that form and let a redirect
 * shadow the page anyway.
 */
async function findLiveEntity(
  strapi: Core.Strapi,
  path: string,
): Promise<{ kind: IdentityKind; name: string; slug: string } | null> {
  const route = path.replace(/^\/+/, '');
  if (!route) return null;
  const routeKey = route.toLowerCase();

  for (const targetUid of IDENTITY_UIDS) {
    const kind = KIND_BY_UID[targetUid];
    if (!kind) continue;

    // The three stored forms that all route to `route`.
    const candidates = routeSlugCandidates(route, kind);

    const rows: unknown = await strapi.documents(targetUid).findMany({
      filters: { $or: candidates.map((candidate) => ({ slug: { $eqi: candidate } })) } as any,
      fields: ['name', 'slug'],
      limit: ENTITY_CANDIDATE_LIMIT,
    });

    for (const row of Array.isArray(rows) ? rows : []) {
      const slug = readString(row, 'slug');
      if (toRouteSlug(slug, kind).toLowerCase() !== routeKey) continue;
      return {
        kind,
        name: readString(row, 'name') ?? '(untitled)',
        slug: slug ?? route,
      };
    }
  }

  return null;
}

type Edge = { fromPath: string; toPath: string | null; note: string };

/**
 * The active redirect graph, keyed by folded `from`. The row being edited is
 * excluded so the pending version replaces it rather than racing it.
 *
 * An external target is stored as `toPath: null` — the chain ends there and
 * cannot loop back into this site.
 */
async function loadActiveEdges(
  strapi: Core.Strapi,
  excludeDocumentId: string | undefined,
): Promise<Map<string, Edge>> {
  const rows: unknown = await strapi.documents(REDIRECT_UID as any).findMany({
    filters: { active: true } as any,
    fields: ['documentId', 'from', 'to'] as any,
    limit: ACTIVE_REDIRECT_LIMIT,
  });

  const edges = new Map<string, Edge>();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (excludeDocumentId && readString(row, 'documentId') === excludeDocumentId) continue;

    const fromPath = normalizeRedirectPath(readString(row, 'from'));
    if (!fromPath) continue;

    const target = classifyTarget(readString(row, 'to'));
    // A stored row with an unusable target cannot participate in a loop, and
    // must not make an unrelated write fail. Skip it.
    if (target.kind === 'invalid') continue;

    const key = foldPathKey(fromPath);
    // First writer wins, so the walk is deterministic even if the unique
    // index was bypassed by a casing difference.
    if (edges.has(key)) continue;

    edges.set(key, {
      fromPath,
      toPath: target.kind === 'internal' ? target.path : null,
      note: target.kind === 'internal' ? target.path : target.raw,
    });
  }

  return edges;
}

export type ChainProblem = { kind: 'loop' | 'too-long'; path: string[] };

/**
 * Walk the chain starting at `startKey`, bounded twice over: a visited set
 * (catches any loop, however long) and a hop budget (catches a chain that is
 * finite but deeper than the frontend resolver will follow). Returns null when
 * the chain terminates on a real page or an external URL.
 */
export function walkChain(
  edges: Map<string, Edge>,
  startKey: string,
  maxHops: number = REDIRECT_MAX_HOPS,
): ChainProblem | null {
  const start = edges.get(startKey);
  if (!start) return null;

  const visited = new Set<string>([startKey]);
  const display = [start.fromPath];

  let current = start.toPath;
  let hops = 1;

  while (current !== null) {
    const key = foldPathKey(current);
    display.push(current);

    if (visited.has(key)) return { kind: 'loop', path: display };
    visited.add(key);

    if (hops > maxHops) return { kind: 'too-long', path: display };

    const next = edges.get(key);
    if (!next) return null; // lands on a real page — the chain terminates

    current = next.toPath;
    hops += 1;
  }

  return null; // ended on an external URL
}

/**
 * Another ACTIVE redirect already claiming the same folded `from`.
 * The column is `unique`, but Postgres uniqueness is byte-exact, so
 * `/Winter-Sale` and `/winter-sale` both save and one silently wins.
 */
function findDuplicateFrom(edges: Map<string, Edge>, fromKey: string): Edge | null {
  return edges.get(fromKey) ?? null;
}

/**
 * Validate a redirect write. No-op for every other content type and for any
 * payload that leaves from/to/active/statusCode alone. Throws
 * errors.ValidationError with details.errors[].path so the admin highlights
 * the offending field inline instead of surfacing a raw 500.
 */
export async function validateRedirect(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
  documentId?: string,
  strict: boolean = false,
): Promise<void> {
  if (!isRedirectUid(uid)) return;
  if (!data || typeof data !== 'object') return;

  const has = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const fromTouched = has('from');
  const toTouched = has('to');
  const activeTouched = has('active');
  const isClone = action === 'clone';

  // Every NON-strict write that leaves the routing-relevant fields alone (a
  // `note` edit, a `statusCode`-only change, any future partial update, and
  // notably the cron/programmatic path) stops here — no read, no query, no
  // chance of failing on a stale value the writer never saw. Under strict a
  // human save must clean the whole record, so even a note-only edit runs the
  // full guard set against the effective row.
  if (!strict && !isClone && !fromTouched && !toTouched && !activeTouched) return;

  const isCreate = action === 'create';

  const stored: unknown =
    (action === 'update' || isClone) && documentId
      ? await strapi.documents(REDIRECT_UID as any).findOne({
          documentId,
          fields: ['documentId', 'from', 'to', 'active'] as any,
        })
      : null;
  if (isClone && documentId && !stored) return;

  // Payload merged OVER the stored row — never derive from the payload alone.
  const mergedFrom = fromTouched ? Reflect.get(data, 'from') : readString(stored, 'from');
  const mergedTo = toTouched ? Reflect.get(data, 'to') : readString(stored, 'to');
  const mergedActive = activeTouched
    ? Reflect.get(data, 'active') !== false
    : (readBoolean(stored, 'active') ?? true);

  const fromPath = normalizeRedirectPath(mergedFrom);
  const fromKey = foldPathKey(fromPath);
  const target = classifyTarget(mergedTo);

  const storedFromKey = redirectKey(readString(stored, 'from'));
  // strict re-arms every guard against the whole effective record, so a dirty
  // untouched `from`/`to` on a legacy row is no longer grandfathered on a human
  // save — the record must be fully clean before it saves.
  const fromChanged =
    strict || isClone || (fromTouched && (isCreate || fromKey !== storedFromKey));
  const toChanged =
    strict ||
    isClone ||
    (toTouched &&
      (isCreate ||
        (typeof mergedTo === 'string' ? mergedTo.trim() : '') !==
          (readString(stored, 'to') ?? '').trim()));
  // Switching a row ON is the moment a shadowing or looping rule starts
  // executing, so it re-arms the live checks even though `from` is untouched.
  const activated =
    mergedActive &&
    (isCreate ||
      isClone ||
      (activeTouched && readBoolean(stored, 'active') !== true));

  const problems: Problem[] = [];

  if (fromChanged && !fromPath) {
    problems.push({
      path: ['from'],
      message:
        'From must be a path on this site starting with "/", for example "/old-page".',
    });
  } else if (fromChanged && fromPath && !isWireSafeFromPath(fromPath)) {
    // F5: a raw character the browser would percent-encode on the wire (a
    // space, apostrophe, parenthesis, comma, accented letter, …) can never
    // match the request, which arrives already encoded. Force the wire form.
    problems.push({
      path: ['from'],
      message:
        `"${fromPath}" contains a character that must be percent-encoded to ` +
        `match a real request (a space, apostrophe, parenthesis, comma or ` +
        `similar). The site compares the URL exactly as the browser sends it, ` +
        `so write the encoded form instead — for example "/mens-sale" or ` +
        `"/men%27s", and "/caf%C3%A9" for "/café". Use only letters, digits, ` +
        `"-", ".", "_", "~", "/", or "%XX" escapes.`,
    });
  } else if (fromChanged && fromPath && isAssetFromPath(fromPath)) {
    // The gateway answers asset requests before the redirect table is ever
    // consulted, so a rule from an asset path saves but never runs.
    problems.push({
      path: ['from'],
      message:
        `"${fromPath}" is served as a static asset, so a redirect from it ` +
        `would never run — the server answers asset requests before the ` +
        `redirect table is consulted. Redirect a retired page URL instead.`,
    });
  }

  if (toChanged && target.kind === 'invalid') {
    problems.push({ path: ['to'], message: `To ${target.reason}.` });
  }

  // Cross-field guards need BOTH sides usable. When the unusable side is one
  // this writer did not touch, skip rather than block — that is the
  // grandfathering rule, and it is why these are not `else` branches above.
  const usable = Boolean(fromPath) && target.kind !== 'invalid';
  const liveChecks = mergedActive && (fromChanged || activated);

  // 1. Self-redirect. Cheap, no query, and unconditionally fatal.
  if (usable && (fromChanged || toChanged) && target.kind === 'internal') {
    if (target.key === fromKey) {
      problems.push({
        path: ['to'],
        message:
          `To and From both resolve to "${fromPath}", so this rule redirects the ` +
          `URL to itself. The browser would follow it until it gives up and the ` +
          `page would be unreachable. Point To at a different path.`,
      });
    }
  }

  // 2. Shadowing a live page. THE critical guard.
  if (usable && liveChecks && problems.length === 0) {
    // The site root is always a live, durable page (the home page) but has no
    // path segment for the reserved/entity lookups below to match. At the ISR
    // gateway the home page is served from the durable cache BEFORE the authored
    // redirect map is consulted, so a redirect `from: "/"` would be silently
    // ignored in production while still taking the home page offline under SSR.
    // Reject it outright. (Unambiguous asset paths are rejected by the
    // isAssetFromPath guard above; entities created AFTER a rule is authored
    // can still shadow at the gateway — those are not knowable here.)
    if (fromPath === '/') {
      problems.push({
        path: ['from'],
        message:
          '"/" is the site home page. A redirect from "/" runs before routing ' +
          'and would take the home page offline for every visitor. Redirect a ' +
          'retired URL instead.',
      });
    }
    const reserved =
      problems.length === 0
        ? RESERVED_ROUTE_SEGMENTS.get(
            fromPath.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '',
          )
        : undefined;
    if (reserved) {
      problems.push({
        path: ['from'],
        message:
          `"${fromPath}" is served by ${reserved}. This redirect runs before ` +
          `routing, so saving it would take that page offline for every visitor. ` +
          `Redirect a retired URL instead.`,
      });
    } else if (problems.length === 0) {
      const entity = await findLiveEntity(strapi, fromPath);
      if (entity) {
        const via = entity.slug.toLowerCase() === fromPath.replace(/^\/+/, '').toLowerCase()
          ? ''
          : ` (stored as "${entity.slug}")`;
        problems.push({
          path: ['from'],
          message:
            `"${fromPath}" is the live page of the ${entity.kind} "${entity.name}"` +
            `${via}. This redirect runs before routing, so saving it would make ` +
            `that page unreachable everywhere on the site while it still appears ` +
            `in the sitemap and in every link to it. Redirect a retired URL, or ` +
            `delete/rename the ${entity.kind} first.`,
        });
      }
    }
  }

  // 2b. Table-size cap, enforced at write. The frontend resolver pages in at
  // most MAX_REDIRECT_PAGES × 100 rows and the cycle walk below loads at most
  // ACTIVE_REDIRECT_LIMIT edges, so an active rule beyond that ceiling is saved
  // but NEVER executes (and can hide a cycle from the walk). Only a write that
  // ADDS an active rule — a create/clone that is active, or an activation —
  // pays for the count; editing an already-active row does not.
  if (activated && problems.length === 0) {
    const activeCount: number = await strapi.documents(REDIRECT_UID as any).count({
      filters: { active: true } as any,
    });
    if (activeCount >= ACTIVE_REDIRECT_LIMIT) {
      problems.push({
        path: ['active'],
        message:
          `The redirect table is limited to ${ACTIVE_REDIRECT_LIMIT.toLocaleString()} ` +
          `active rules — beyond that a rule is saved but never runs. There are ` +
          `already ${activeCount.toLocaleString()}. Switch an unused rule off before ` +
          `adding another.`,
      });
    }
  }

  // 3. Duplicate `from`, and cycle detection across the whole active graph.
  // The two checks share one graph load but re-arm on DIFFERENT edits:
  //  - the DUPLICATE check re-arms on (fromChanged || activated) only. A
  //    to-only edit on a legacy row whose `from` case-folds onto another
  //    active row (a casing variant that slipped past the byte-exact unique
  //    index) must still save — the editor never touched `from`, and blocking
  //    the save would also block ever fixing that row.
  //  - the CYCLE walk re-arms on toChanged as well, because pointing `to` at
  //    a new destination is exactly how a cycle is closed.
  // A clone forces fromChanged (isClone), so it always re-arms both.
  const duplicateArmed = fromChanged || activated;
  const cycleArmed = fromChanged || toChanged || activated;
  if (usable && mergedActive && cycleArmed && problems.length === 0) {
    const edges = await loadActiveEdges(
      strapi,
      action === 'update' ? documentId : undefined,
    );

    const duplicate = duplicateArmed ? findDuplicateFrom(edges, fromKey) : null;
    if (duplicate) {
      problems.push({
        path: ['from'],
        message:
          `Another active redirect already sends "${duplicate.fromPath}" to ` +
          `"${duplicate.note}". Two rules for one URL means only one of them ` +
          `ever runs, and which one is arbitrary. Edit that rule instead, or ` +
          `switch it off.`,
      });
    } else {
      // Insert the pending edge, then walk from it. On a to-only edit of a
      // legacy duplicate row this OVERWRITES the other row's edge for the
      // walk — the row being written is the edge whose acyclicity matters.
      edges.set(fromKey, {
        fromPath,
        toPath: target.kind === 'internal' ? target.path : null,
        note: target.kind === 'internal' ? target.path : target.raw,
      });

      const chain = walkChain(edges, fromKey);
      if (chain?.kind === 'loop') {
        problems.push({
          path: ['to'],
          message:
            `This rule closes a redirect loop: ${chain.path.join(' → ')}. Visitors ` +
            `would be bounced between those URLs until the browser gives up. ` +
            `Point To at a page that is not itself redirected.`,
        });
      } else if (chain?.kind === 'too-long') {
        problems.push({
          path: ['to'],
          message:
            `This rule makes a redirect chain longer than ${REDIRECT_MAX_HOPS} hops: ` +
            `${chain.path.join(' → ')}. The site only follows ${REDIRECT_MAX_HOPS}, so ` +
            `visitors would be left part-way along it. Point To at the final ` +
            `destination directly.`,
        });
      }
    }
  }

  if (!problems.length) return;

  const noun = problems.length === 1 ? 'problem' : 'problems';
  throw new errors.ValidationError(
    `This redirect has ${problems.length} ${noun} (the fields are highlighted in ` +
      `the form):\n• ${problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('\n• ')}`,
    {
      errors: problems.map((p) => ({
        path: p.path,
        message: p.message,
        name: 'ValidationError',
      })),
      problems: problems.map((p) => `${p.path.join('.')}: ${p.message}`),
    }
  );
}
