import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { slugify } from '../constants/slugify';
import { toRouteSlug, type IdentityKind } from './route-normalization';
import { entityDealPageSlug } from '../api/entity-deal-page/services/entity-deal-route';
import { RESERVED_ROUTE_SEGMENTS } from './reserved-route-segments';
import {
  IDENTITY_UIDS,
  KIND_BY_UID,
  isIdentityUid,
  type IdentityUid,
} from './identity-uids';
import {
  findActiveRedirectCollision,
  findDealPageCollision,
  findDuplicateName,
  findSlugCollision,
  toNameKey,
} from './identity-collisions';
import { readString } from './row-fields';

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

// UID registry: ./identity-uids. Collision queries: ./identity-collisions.
// Reserved segments: ./reserved-route-segments (shared with the redirect
// validator).

type Problem = { path: string[]; message: string };

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
          const dealPageCollision = await findDealPageCollision(
            strapi,
            uid,
            incomingRoute,
            excludeDocumentId,
          );
          if (dealPageCollision) {
            problems.push({
              path: ['slug'],
              message:
                `Slug "${incomingRoute}" is reserved for the generated Product ` +
                `Deal page of the ${dealPageCollision.kind} ` +
                `"${dealPageCollision.name}" at /${incomingRoute}/. Choose a ` +
                `different entity-page slug.`,
            });
          } else {
            const redirect = await findActiveRedirectCollision(strapi, incomingRoute);
            if (redirect) {
              problems.push({
                path: ['slug'],
                message:
                  `URL "/${incomingRoute}/" is already claimed by the active ` +
                  `redirect "${redirect.from}" → "${redirect.to}". Redirects run ` +
                  `before entity routing, so this ${kind}'s entity page would be ` +
                  `unreachable. Disable or move that redirect first.`,
              });
            }
          }
        }
      }
    }
  }

  const dealRoute = entityDealPageSlug(effectiveName);
  let duplicateNameFound = false;
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
        duplicateNameFound = true;
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

  if (nameChanged || slugChanged) {
    if (!dealRoute) {
      if (incomingRoute || !slugChanged) {
        problems.push({
          path: ['name'],
          message:
            `"${String(effectiveName ?? '').trim() || 'This name'}" contains no ` +
            `characters the generated Product Deal URL can use. Add a Latin-script ` +
            `name so the Deal page can receive a stable "-deals" route.`,
        });
      }
    } else if (incomingRoute) {
      if (incomingRoute === dealRoute) {
        problems.push({
          path: ['slug'],
          message:
            `Slug "${incomingRoute}" is also the generated Product Deal URL from ` +
            `this entity's name. Choose a different entity-page slug so both pages ` +
            `remain reachable.`,
        });
      } else {
        const [entityCollision, generatedCollision, redirect] = await Promise.all([
          findSlugCollision(strapi, uid, dealRoute, excludeDocumentId),
          duplicateNameFound
            ? Promise.resolve(null)
            : findDealPageCollision(strapi, uid, dealRoute, excludeDocumentId),
          findActiveRedirectCollision(strapi, dealRoute),
        ]);

        if (entityCollision) {
          problems.push({
            path: ['name'],
            message:
              `Name "${String(effectiveName ?? '').trim()}" generates ` +
              `/${dealRoute}/ for its Product Deal page, but that URL is already ` +
              `the entity page of the ${entityCollision.kind} ` +
              `"${entityCollision.name}". Choose a different name.`,
          });
        } else if (generatedCollision) {
          problems.push({
            path: ['name'],
            message:
              `Name "${String(effectiveName ?? '').trim()}" generates the same ` +
              `Product Deal URL /${dealRoute}/ as the ` +
              `${generatedCollision.kind} "${generatedCollision.name}". Choose a ` +
              `name with a different URL form.`,
          });
        } else if (redirect) {
          problems.push({
            path: ['name'],
            message:
              `The generated Product Deal URL "/${dealRoute}/" is already claimed ` +
              `by the active redirect "${redirect.from}" → "${redirect.to}". ` +
              `Disable or move that redirect, or choose a different name.`,
          });
        }
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
// generator this module uses, rather than a second copy of the rules.
export { slugify };
export { toRouteSlug };
export type { IdentityKind };
