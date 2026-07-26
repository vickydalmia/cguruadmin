import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { slugify } from '../constants/slugify';
import {
  routeSlugCandidates,
  toRouteSlug,
  type IdentityKind,
} from './route-normalization';

/**
 * Identity rules for the taxonomy content types (store / brand / category /
 * bank): unique name within a type, unique PUBLIC ROUTE across all four types,
 * no collision with a reserved frontend route, and no routeless entity.
 *
 * WHY A LIFECYCLE CHECK AND NOT `"unique": true` ON name
 * ------------------------------------------------------
 * Two reasons, both fatal:
 *  - Postgres uniqueness is byte-exact, so "Amazon", "amazon " and "AMAZON"
 *    would all still save. That is precisely the bug being fixed.
 *  - Strapi builds schema indexes at boot. Adding a unique index to a column
 *    that already holds one duplicate turns the next production deploy into a
 *    hard startup failure. A validator degrades to "editors see an error";
 *    an index degrades to "the CMS does not start".
 *
 * WHY SLUG UNIQUENESS IS CROSS-TYPE (row 113, P0)
 * -----------------------------------------------
 * The public URL space is FLAT: cguru-ui/src/features/routing/services/
 * public-urls.ts renders every store/brand/category/bank at `/{slug}/`, and
 * get-flat-routes.ts runs assertUniqueSlugs() over the union of all four
 * collections. A duplicate there THROWS and the static build fails; the ISR
 * server instead drops the loser, silently unpublishing a live page. So a Bank
 * taking a Store's slug is a build breaker, not untidiness.
 *
 * Comparison happens on the NORMALIZED ROUTE SLUG, not the raw column, because
 * the frontend strips a leading type namespace before routing:
 * normalizeTypedSlug() turns a stored "stores/amazon" into the route "amazon".
 * A raw string comparison would therefore miss the store "stores/amazon" vs
 * the bank "amazon" collision, which is a real one — both render `/amazon/`.
 *
 * GRANDFATHERING
 * --------------
 * These rules land on a populated production database. A rule that blocks an
 * editor from saving a legacy row they did not touch is worse than the bug it
 * fixes. So every rule is gated on the payload ACTUALLY CHANGING the field:
 * on update the stored document is read and compared, and an untouched field
 * is skipped even when its stored value is invalid. Creates are validated on
 * whatever the payload carries.
 *
 * Partial payloads: the offer-expiry cron issues `update({ data: { contentStatus } })`
 * with no name and no slug. That returns at the `!nameTouched && !slugTouched`
 * guard before any query runs, so the cron never pays for this and never trips
 * a legacy row.
 */

export const IDENTITY_UIDS = [
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
] as const;

export type IdentityUid = (typeof IDENTITY_UIDS)[number];

const KIND_BY_UID: Record<IdentityUid, IdentityKind> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};

/**
 * First path segments already owned by a real page in
 * cguru-ui/src/pages/. An entity slug equal to one of these produces a
 * `/{slug}/` route the framework already claims, so the entity page is either
 * shadowed or overwrites a static page in the build output.
 *
 * Derived from the actual files/namespaces — do not add speculative entries:
 *   api/, 404.astro, 500.astro, about-us.astro, banks.astro, brands.astro,
 *   careers.astro + careers/[slug].astro, categories.astro, coupon/[id].astro,
 *   deal/[id].astro, error-pages/[code].astro + error-pages/template.astro,
 *   redeem-unavailable.astro, robots.txt.ts, search.astro,
 *   sitemap_index.xml.ts + sitemap/[shard].xml.ts, stores.astro
 * (index.astro is the root and [...slug].astro is the entity catch-all itself,
 * so neither reserves a segment.)
 */
const RESERVED_ROUTE_SEGMENTS = new Map<string, string>([
  ['404', 'the 404 page (src/pages/404.astro)'],
  ['500', 'the 500 page (src/pages/500.astro)'],
  ['about-us', 'the About Us page (src/pages/about-us.astro)'],
  ['api', 'the internal API namespace (src/pages/api/)'],
  ['banks', 'the bank listing page (src/pages/banks.astro)'],
  ['brands', 'the brand listing page (src/pages/brands.astro)'],
  ['careers', 'the careers pages (src/pages/careers.astro, careers/[slug].astro)'],
  ['categories', 'the category listing page (src/pages/categories.astro)'],
  ['coupon', 'the coupon detail pages (src/pages/coupon/[id].astro)'],
  ['deal', 'the deal detail pages (src/pages/deal/[id].astro)'],
  ['error-pages', 'the error pages (src/pages/error-pages/)'],
  ['redeem-unavailable', 'the redeem fallback page (src/pages/redeem-unavailable.astro)'],
  ['robots.txt', 'the robots.txt route (src/pages/robots.txt.ts)'],
  ['search', 'the search page (src/pages/search.astro)'],
  ['sitemap', 'the sitemap shard namespace (src/pages/sitemap/[shard].xml.ts)'],
  ['sitemap_index.xml', 'the sitemap index route (src/pages/sitemap_index.xml.ts)'],
  ['stores', 'the store listing page (src/pages/stores.astro)'],
]);

// `$containsi` compiles to `LIKE '%value%'`, which cannot use an index — but
// these tables hold hundreds of rows, and the query only runs when the name
// actually changed. Candidates are read in pages (below) rather than truncated
// at a single limit: a single limit silently DROPPED any true duplicate past
// the cap, letting a supposedly-unique name save (#8). NAME_SCAN_PAGE is the
// page size; NAME_SCAN_MAX_PAGES only backstops a pathological one-character
// name against an unbounded scan, and hitting it is logged, never silent.
const NAME_SCAN_PAGE = 500;
const NAME_SCAN_MAX_PAGES = 40;
const SLUG_CANDIDATE_LIMIT = 25;

type Problem = { path: string[]; message: string };

export function isIdentityUid(uid: string): uid is IdentityUid {
  return IDENTITY_UIDS.includes(uid as IdentityUid);
}

function readString(row: unknown, key: string): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = Reflect.get(row, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The key names are compared on: case-insensitive and trim-insensitive, so
 * "Amazon", "amazon" and " AMAZON " are one name.
 */
export function toNameKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Another row of the SAME type carrying the same name, ignoring case and
 * surrounding whitespace. Returns its name, or null.
 *
 * The filter is a NARROWING PASS ONLY. `$containsi` is a LIKE, so a name
 * containing '%' or '_' wildcards — "50% Off Store" must still save — matches
 * rows that are not equal to it. LIKE with those wildcards always returns a
 * SUPERSET of the true matches (never fewer), which is exactly what a
 * candidate query needs: every hit is then confirmed in JS with an exact
 * key comparison, and the wildcard extras are discarded.
 */
async function findDuplicateName(
  strapi: Core.Strapi,
  uid: IdentityUid,
  name: string,
  documentId: string | undefined,
): Promise<string | null> {
  const key = toNameKey(name);
  if (!key) return null;

  // `$containsi` rather than `$eqi`: it is the narrowest sound superset that
  // also catches stored names with leading/trailing whitespace, which an exact
  // `$eqi` on the trimmed value would miss. Read EVERY candidate page rather
  // than a single capped slice — a cap would silently let a real duplicate past
  // it save (#8). The exact key comparison then confirms each candidate in JS.
  for (let page = 0; page < NAME_SCAN_MAX_PAGES; page += 1) {
    const rows: unknown = await strapi.documents(uid).findMany({
      filters: { name: { $containsi: name.trim() } },
      fields: ['documentId', 'name'],
      limit: NAME_SCAN_PAGE,
      start: page * NAME_SCAN_PAGE,
    });

    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      if (documentId && readString(row, 'documentId') === documentId) continue;
      const candidate = readString(row, 'name');
      if (candidate !== undefined && toNameKey(candidate) === key) return candidate;
    }

    // A short page is the last page — the whole candidate set has been scanned.
    if (list.length < NAME_SCAN_PAGE) return null;
  }

  // Only a pathological broad match (e.g. a one-character name matching most of
  // an unexpectedly huge table) reaches here. Do not fail silently: log so the
  // uniqueness check is known to be incomplete for this one save.
  strapi.log.warn(
    `[identity] name uniqueness scan for ${uid} hit ${NAME_SCAN_MAX_PAGES} pages ` +
      `(${NAME_SCAN_MAX_PAGES * NAME_SCAN_PAGE} rows) without exhausting candidates — ` +
      `duplicate detection may be incomplete for "${name.trim()}".`,
  );
  return null;
}

/**
 * A row of ANY of the four types already routing at the same public slug.
 *
 * The filter is exact (`$in` over the canonical stored forms), so no LIKE
 * wildcard can leak in here; the JS pass re-derives each candidate's route
 * slug anyway so the decision never rests on the filter alone.
 */
async function findSlugCollision(
  strapi: Core.Strapi,
  uid: IdentityUid,
  route: string,
  documentId: string | undefined,
): Promise<{ kind: IdentityKind; name: string; slug: string } | null> {
  for (const targetUid of IDENTITY_UIDS) {
    const targetKind = KIND_BY_UID[targetUid];
    // A stored slug routes to `route` only if it is `route` itself or `route`
    // behind its own type namespace — the three forms normalizeTypedSlug()
    // collapses.
    const candidates = routeSlugCandidates(route, targetKind);

    const rows: unknown = await strapi.documents(targetUid).findMany({
      filters: {
        $or: candidates.map((candidate) => ({ slug: { $eqi: candidate } })),
      } as any,
      fields: ['documentId', 'name', 'slug'],
      limit: SLUG_CANDIDATE_LIMIT,
    });

    for (const row of Array.isArray(rows) ? rows : []) {
      const rowId = readString(row, 'documentId');
      if (targetUid === uid && documentId && rowId === documentId) continue;

      const slug = readString(row, 'slug');
      if (toRouteSlug(slug, targetKind) !== route) continue;

      return {
        kind: targetKind,
        name: readString(row, 'name') ?? '(untitled)',
        slug: slug ?? route,
      };
    }
  }
  return null;
}

async function findActiveRedirectCollision(
  strapi: Core.Strapi,
  route: string,
): Promise<{ from: string; to: string } | null> {
  const rows: unknown = await strapi
    .documents('api::redirect.redirect' as any)
    .findMany({
      filters: { active: true } as any,
      fields: ['from', 'to'] as any,
      limit: 2000,
    });
  const routeKey = `/${route}`.toLowerCase();

  for (const row of Array.isArray(rows) ? rows : []) {
    const from = readString(row, 'from');
    if (!from) continue;
    const normalized = from
      .trim()
      .split(/[?#]/, 1)[0]!
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/g, '');
    const fromKey = (normalized.startsWith('/') ? normalized : `/${normalized}`)
      .toLowerCase();
    if (fromKey === routeKey) {
      return { from, to: readString(row, 'to') ?? '(unknown target)' };
    }
  }
  return null;
}

function emptySlugMessage(kind: IdentityKind, name: string | undefined): string {
  const label = name && name.trim() ? `"${name.trim()}"` : 'This name';
  return (
    `${label} contains no characters a URL slug can use, so the slug comes out ` +
    `empty and this ${kind} would have no public page at all. Slugs keep only ` +
    `a-z and 0-9 (accents are folded, e.g. "Nescafé" becomes "nescafe"), and a ` +
    `name written entirely in a non-Latin script — Japanese, Devanagari, Arabic ` +
    `— leaves nothing behind. Add a Latin-script name, or type the slug by hand.`
  );
}

/**
 * Validate the identity fields (name, slug) of a taxonomy payload. No-op for
 * any other content type, and for any payload that touches neither field.
 * Throws errors.ValidationError with details.errors[].path so the admin
 * highlights the offending field inline instead of surfacing a raw 500.
 */
export async function validateIdentity(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
  documentId?: string,
  strict = false,
): Promise<void> {
  if (!isIdentityUid(uid)) return;
  if (!data || typeof data !== 'object') return;

  const nameTouched = Object.prototype.hasOwnProperty.call(data, 'name');
  const slugTouched = Object.prototype.hasOwnProperty.call(data, 'slug');
  const isClone = action === 'clone';
  // The cron's `update({ data: { contentStatus } })` and every other partial
  // write that leaves identity alone stop here — no read, no query, no risk of
  // failing on a legacy value the writer never saw. Clone is the exception:
  // Strapi merges omitted identity fields from the source after middleware,
  // and those inherited values must be checked as a new document. STRICT is the
  // other exception: a human admin save must validate the whole record's name
  // and slug even when the editor touched some third field, so we read the
  // stored row and check the effective identity below.
  if (!isClone && !strict && !nameTouched && !slugTouched) return;

  const kind = KIND_BY_UID[uid];
  const isCreate = action === 'create';

  const incomingName = nameTouched ? Reflect.get(data, 'name') : undefined;
  const incomingSlug = slugTouched ? Reflect.get(data, 'slug') : undefined;

  // Stored row for update grandfathering and as the clone merge base. Never
  // read on a fresh create.
  const stored: unknown =
    (action === 'update' || isClone) && documentId
      ? await strapi.documents(uid).findOne({
          documentId,
          fields: ['documentId', 'name', 'slug'],
        })
      : null;

  // Let Strapi report its own source-not-found error instead of replacing it
  // with misleading blank identity errors.
  if (isClone && documentId && !stored) return;

  const storedName = readString(stored, 'name');
  const storedSlug = readString(stored, 'slug');
  const effectiveName = nameTouched ? incomingName : storedName;
  const effectiveSlug = slugTouched ? incomingSlug : storedSlug;

  const incomingRoute = toRouteSlug(effectiveSlug, kind);
  // STRICT forces both checks against the effective identity (payload over
  // stored), so a migrated row whose untouched slug is uppercase, reserved or
  // collides now blocks the save. Non-strict keeps the grandfather: only a
  // field the payload actually changes is checked, so the cron and unrelated
  // edits stay green on dirty legacy values.
  const nameChanged =
    strict ||
    isClone ||
    (nameTouched && (isCreate || toNameKey(incomingName) !== toNameKey(storedName)));
  const slugChanged =
    strict ||
    isClone ||
    (slugTouched && (isCreate || incomingRoute !== toRouteSlug(storedSlug, kind)));
  // Updates replace their own row and therefore exclude it. A clone leaves its
  // source in place, so the source must participate in both uniqueness checks.
  const excludeDocumentId = action === 'update' ? documentId : undefined;

  const problems: Problem[] = [];

  if (slugChanged) {
    if (!incomingRoute) {
      // Row 102: a name in a non-Latin script slugifies to ''. Reject with an
      // explanation on `name` — that is the field the editor has to change —
      // rather than saving a routeless entity or letting the bare `required`
      // check fire an unexplained error on an empty slug box.
      problems.push({
        path: ['name'],
        message: emptySlugMessage(kind, String(effectiveName ?? '')),
      });
    } else {
      const reserved = RESERVED_ROUTE_SEGMENTS.get(incomingRoute.split('/')[0] ?? '');
      if (reserved) {
        problems.push({
          path: ['slug'],
          message:
            `Slug "${incomingRoute}" is reserved by ${reserved}. Entity pages live ` +
            `at the site root, so this ${kind} would fight that page for /${incomingRoute}/. ` +
            `Choose a different slug.`,
        });
      } else {
        const collision = await findSlugCollision(
          strapi,
          uid,
          incomingRoute,
          excludeDocumentId,
        );
        if (collision) {
          const via =
            collision.slug === incomingRoute ? '' : ` (stored as "${collision.slug}")`;
          problems.push({
            path: ['slug'],
            message:
              `Slug "${incomingRoute}" is already used by the ${collision.kind} ` +
              `"${collision.name}"${via}. Stores, brands, categories and banks share ` +
              `one flat URL space, so only one of them can own /${incomingRoute}/ — ` +
              `two would break the site build. Choose a different slug.`,
          });
        } else {
          const redirect = await findActiveRedirectCollision(strapi, incomingRoute);
          if (redirect) {
            problems.push({
              path: ['slug'],
              message:
                `Slug "${incomingRoute}" is already claimed by the active redirect ` +
                `"${redirect.from}" → "${redirect.to}". Redirects run before entity ` +
                `routing, so this ${kind}'s page would be unreachable. Disable or ` +
                `move that redirect before using this slug.`,
            });
          }
        }
      }
    }
  }

  if (nameChanged) {
    const trimmed = typeof effectiveName === 'string' ? effectiveName.trim() : '';
    if (trimmed) {
      const duplicate = await findDuplicateName(
        strapi,
        uid,
        trimmed,
        excludeDocumentId,
      );
      if (duplicate !== null) {
        problems.push({
          path: ['name'],
          message:
            `Another ${kind} is already named "${duplicate}". ${kind[0]!.toUpperCase()}` +
            `${kind.slice(1)} names must be unique, compared ignoring capitalisation ` +
            `and surrounding spaces. Rename this entry so editors can tell the two apart.`,
        });
      }
    }
  }

  if (!problems.length) return;

  const noun = problems.length === 1 ? 'problem' : 'problems';
  throw new errors.ValidationError(
    `This entry has ${problems.length} identity ${noun} (the fields are ` +
      `highlighted in the form):\n• ${problems
        .map((p) => `${p.path.join('.')}: ${p.message}`)
        .join('\n• ')}`,
    {
      // The admin edit view maps details.errors[].path to an inline error on
      // that exact field (same mechanism as the offer/entity/homepage checks).
      errors: problems.map((p) => ({
        path: p.path,
        message: p.message,
        name: 'ValidationError',
      })),
      // Flat shape kept for non-admin API consumers.
      problems: problems.map((p) => `${p.path.join('.')}: ${p.message}`),
    }
  );
}

// Re-exported so a caller (and the tests) can assert against the same slug
// generator the admin SlugInput uses, rather than a second copy of the rules.
export { slugify };
export { toRouteSlug };
export type { IdentityKind };
