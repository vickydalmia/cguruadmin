import type { Core } from '@strapi/strapi';
import type { ScopeRequest } from './types';
import { mergeScope } from './payload';
import { toRouteSlug } from '../utils/route-normalization';
import { entityDealPageSlug } from '../api/entity-deal-page/services/entity-deal-route';
import { DOCUMENT_WRITE_ACTIONS } from '../constants/document-write';
import {
  ABOUT_PAGE_SLUG,
  ABOUT_PAGE_UID,
  AFFILIATE_DISCLOSURE_PAGE_SLUG,
  AFFILIATE_DISCLOSURE_PAGE_UID,
  CAREER_PAGE_SLUG,
  CAREER_PAGE_UID,
  CHROME_UIDS,
  CONTACT_PAGE_SLUG,
  CONTACT_PAGE_UID,
  CULTURE_PAGE_SLUG,
  CULTURE_PAGE_UID,
  DEAL_OF_THE_DAY_SLUG,
  DOTD_PAGE_UID,
  ERROR_DOCUMENT_SLUGS,
  ERROR_PAGE_UID,
  FAQ_PAGE_SLUG,
  FAQ_PAGE_UID,
  INDEPENDENCE_DAY_SALE_PAGE_UID,
  INDEPENDENCE_DAY_SALE_SLUG,
  JOB_UID,
  PARTNER_WITH_US_PAGE_SLUG,
  PARTNER_WITH_US_PAGE_UID,
  PRIVACY_POLICY_PAGE_SLUG,
  PRIVACY_POLICY_PAGE_UID,
  TERMS_PAGE_SLUG,
  TERMS_PAGE_UID,
  TESTIMONIALS_PAGE_SLUG,
  TESTIMONIALS_PAGE_UID,
  withOfferLandingSlugs,
} from './scope-static-pages';
import {
  ENTITY_UIDS,
  OFFER_UIDS,
  offerRelationScope,
  publicSlug,
} from './offer-relation-scopes';
import {
  festiveMerchantScope,
  festiveOfferChanged,
  touchesFestiveOffer,
  type FestiveOfferSnapshot,
} from './festive-offer-scopes';

// Maps a Strapi document change to every rendered page that consumes it.
// Static-page mapping lives in ./scope-static-pages, offer relation scopes
// (and preDeleteScope) in ./offer-relation-scopes, festive-offer scopes in
// ./festive-offer-scopes; this file keeps the computeScope coordinator and
// the redirect note-only suppression.

// A redirect is evaluated by cguru-ui/src/middleware.ts on EVERY request,
// before routing — it is URL resolution itself, not page content. Nothing
// narrower than `full` is correct here: the affected URL set is not derivable
// from the row (a redirect names a path that has no page and therefore no
// slug in the scope vocabulary), and the change also moves the route manifest
// the ISR gateway admits paths against. Redirect edits are rare, so paying for
// a full regeneration is the cheap side of the trade. Two refinements ride on top:
// the gateway eagerly reloads its authored-redirect map when an event carries
// the "redirects" scope (every all=true event does — see the gateway's
// revalidationScopes), and note-only edits skip the sweep entirely via
// isRedirectNoteOnlyChange below.
const REDIRECT_UID = 'api::redirect.redirect';

/**
 * True when an entity update touches ONLY the hidden entityDealPageSeo
 * component. That component renders on exactly one page — the generated
 * name-derived `<entity-name>-deals` route — so it must not drag the entity
 * page, the homepage or
 * the deal-of-the-day landing page along with it.
 *
 * Uncertainty returns false, keeping the broad scope: a wrong `true` silently
 * serves stale HTML, a wrong `false` only costs a rebuild.
 */
export function isEntityDealPageSeoOnlyChange(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.length === 1 && keys[0] === 'entityDealPageSeo';
}

/** Scope for a change, computed AFTER the write succeeded. */
export async function computeScope(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  documentId: string | undefined,
  data?: unknown,
  // Festive fields read from the row BEFORE the write (Store/Brand updates
  // only — see the capture in src/register/document-write-middleware.ts).
  // Undefined means "not captured"; festiveOfferChanged() then fails toward
  // invalidation.
  festiveOfferBefore?: FestiveOfferSnapshot | null,
): Promise<ScopeRequest | null> {
  if (!DOCUMENT_WRITE_ACTIONS.has(action)) return null;

  if (uid === 'api::homepage.homepage') {
    return { homepage: true, sitemap: true };
  }
  if (uid === DOTD_PAGE_UID) {
    return { slugs: [DEAL_OF_THE_DAY_SLUG], sitemap: true };
  }
  if (uid === INDEPENDENCE_DAY_SALE_PAGE_UID) {
    return {
      slugs: [INDEPENDENCE_DAY_SALE_SLUG],
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }
  if (uid === ABOUT_PAGE_UID) {
    return {
      slugs: [ABOUT_PAGE_SLUG],
      sitemap: true,
      // The page path is code-owned, but its managed updatedAt/noIndex
      // overlay is cached with the route inventory. Refresh that metadata
      // before the gateway rebuilds the sitemap.
      refreshScopes: ['routes'],
    };
  }
  if (uid === CAREER_PAGE_UID) {
    const jobs: any[] = await strapi.documents(JOB_UID as any).findMany({
      filters: { isActive: true } as any,
      fields: ['slug'] as any,
    });
    return {
      slugs: [
        CAREER_PAGE_SLUG,
        ...jobs.map((job) => `careers/${job.slug}`).filter((slug) => !slug.endsWith('/undefined')),
      ],
      sitemap: true,
      // The page and job paths are already known, but their managed
      // updatedAt/noIndex records share the route-inventory cache. Refresh
      // that projection before regenerating the sitemap and HTML.
      refreshScopes: ['routes'],
    };
  }
  if (uid === CONTACT_PAGE_UID) {
    return {
      slugs: [CONTACT_PAGE_SLUG],
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }
  if (uid === FAQ_PAGE_UID) {
    return {
      slugs: [FAQ_PAGE_SLUG],
      sitemap: true,
      // The path is code-owned, but its managed updatedAt/noIndex overlay is
      // read through the route cache. Refresh that metadata without widening
      // this into a global page invalidation.
      refreshScopes: ['routes'],
    };
  }
  if (uid === TESTIMONIALS_PAGE_UID) {
    return {
      slugs: [TESTIMONIALS_PAGE_SLUG],
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }
  if (uid === PARTNER_WITH_US_PAGE_UID) {
    return {
      slugs: [PARTNER_WITH_US_PAGE_SLUG],
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }
  if (uid === PRIVACY_POLICY_PAGE_UID) {
    return {
      slugs: [PRIVACY_POLICY_PAGE_SLUG],
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }
  if (uid === TERMS_PAGE_UID) {
    return {
      slugs: [TERMS_PAGE_SLUG],
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }
  if (uid === AFFILIATE_DISCLOSURE_PAGE_UID) {
    return {
      slugs: [AFFILIATE_DISCLOSURE_PAGE_SLUG],
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }
  if (uid === CULTURE_PAGE_UID) {
    return {
      slugs: [CULTURE_PAGE_SLUG],
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }
  // A job changes both the listing and one or more build routes. Creation,
  // deletion, or a slug edit also changes the route manifest/sitemap, so use
  // the existing full rebuild safety path for every editor operation.
  if (uid === JOB_UID) return { full: true, refreshScopes: ['routes'] };
  if (uid === REDIRECT_UID) {
    return { full: true, refreshScopes: ['routes', 'redirects'] };
  }
  if (uid === ERROR_PAGE_UID) {
    return {
      slugs: [...ERROR_DOCUMENT_SLUGS],
      refreshScopes: ['error-page'],
    };
  }
  if (CHROME_UIDS.has(uid)) {
    return { full: true, refreshScopes: ['chrome'] };
  }

  if (OFFER_UIDS.has(uid)) {
    // delete is handled via preDeleteScope; if we get here without one, be safe.
    if (action === 'delete') {
      return { full: true, refreshScopes: ['routes'] };
    }
    if (!documentId) return { full: true, refreshScopes: ['routes'] };
    const relationScope = await offerRelationScope(
      strapi,
      uid as any,
      documentId,
    );
    if (relationScope === null) {
      return { full: true, refreshScopes: ['routes'] };
    }
    // An offer with no entity relations only shows via curation surfaces.
    return {
      slugs: withOfferLandingSlugs(uid, relationScope.slugs),
      ...(relationScope.optionalSlugs.length > 0
        ? { optionalSlugs: relationScope.optionalSlugs }
        : {}),
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }

  const kind = ENTITY_UIDS[uid];
  if (kind) {
    // Route membership and sitemap change on entity create/delete.
    if (action === 'create' || action === 'clone' || action === 'delete') {
      return { full: true, refreshScopes: ['routes'] };
    }
    if (!documentId) return { full: true, refreshScopes: ['routes'] };
    const doc: any = await strapi.documents(uid as any).findOne({
      documentId,
      fields: ['name', 'slug'] as any,
    });
    const slug = publicSlug(doc?.slug, kind);
    const dealSlug = entityDealPageSlug(doc?.name);
    if (!slug || !dealSlug) return { full: true, refreshScopes: ['routes'] };

    // A settings-screen write that only sets entityDealPageSeo changes exactly
    // one page. `sitemap` stays because indexingEnabled decides whether the
    // generated route appears in a shard at all.
    if (action === 'update' && isEntityDealPageSeoOnlyChange(data)) {
      return { optionalSlugs: [dealSlug], sitemap: true };
    }

    // A festive change repaints every offer card that names this merchant.
    // Value comparison, not key presence — the content-manager form submits
    // the full document, so the keys are present on EVERY Store/Brand save.
    // The repaint set is computed exactly (festiveMerchantScope) and MERGED
    // into the narrow entity scope below; only a scan overflow or a failed
    // read escalates to a full rebuild.
    let festiveScope: ScopeRequest | null = null;
    if (festiveOfferChanged(data, festiveOfferBefore)) {
      try {
        festiveScope = await festiveMerchantScope(strapi, uid, documentId);
      } catch (err: any) {
        strapi.log.warn(
          `[rebuild] festive merchant scan failed for ${uid} ${documentId}: ${
            err?.message ?? err
          }`,
        );
        festiveScope = { full: true, refreshScopes: ['routes'] };
      }
      if (festiveScope.full) return festiveScope;
      // Nobody checks out with this merchant: nothing festive renders, so
      // only the narrow entity scope below applies.
      if (!festiveScope.slugs?.length) festiveScope = null;
    }

    // The deal landing page bakes store pill labels/logos and category tab
    // names/icons into its HTML — same reason entity edits carry homepage.
    const slugs =
      kind === 'store' || kind === 'category'
        ? [
            ...new Set([
              slug,
              DEAL_OF_THE_DAY_SLUG,
              INDEPENDENCE_DAY_SALE_SLUG,
            ]),
          ]
        : [slug];
    const identityChanged =
      data
      && typeof data === 'object'
      && (
        Object.prototype.hasOwnProperty.call(data, 'name')
        || Object.prototype.hasOwnProperty.call(data, 'slug')
      );
    const narrow: ScopeRequest = {
      slugs,
      optionalSlugs: [dealSlug],
      homepage: true,
      sitemap: true,
      ...(identityChanged ? { refreshScopes: ['routes'] } : {}),
    };
    return festiveScope ? mergeScope(narrow, festiveScope) : narrow;
  }

  return null; // unrelated content type (pools, users…)
}

// `note` is editor-facing metadata: it renders nowhere public (the public
// find projection excludes it), yet the redirect UID scopes to a FULL sweep
// above. The middleware reads these fields before the write and skips the
// rebuild when nothing material changed.
const REDIRECT_MATERIAL_FIELDS = ['from', 'to', 'statusCode', 'active'] as const;

/**
 * True when an update payload leaves every publicly-visible redirect field
 * untouched. Uncertainty must return false — the cost of a wrong `true` is a
 * silently stale redirect, while a wrong `false` merely keeps today's sweep.
 */
export function isRedirectNoteOnlyChange(
  before: Record<string, unknown> | null | undefined,
  data: Record<string, unknown> | null | undefined,
): boolean {
  if (!before || !data) return false;
  return REDIRECT_MATERIAL_FIELDS.every((field) => {
    if (!(field in data)) return true; // omitted from the payload → unchanged
    return (data[field] ?? null) === (before[field] ?? null);
  });
}
