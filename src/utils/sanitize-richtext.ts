/**
 * Server-side sanitization for richtext fields.
 *
 * These fields hold HTML (written by the WP migration, now edited via the
 * custom TipTap editor in src/admin) and are rendered RAW on the public site
 * via Astro `set:html` with no re-sanitization — so every write must pass
 * through the same allowlist the migration used. Config copied verbatim from
 * migration/src/utils/sanitize.ts (separate workspace, can't import).
 * sanitize-html is idempotent on its own output, so unchanged content
 * round-trips byte-identical.
 */

import sanitizeHtmlLib from 'sanitize-html';
import { getDomain } from 'tldts-icann';
import { configuredPublicSiteDomain } from './public-site-url';

// First-party link classification derives from the public site URL. The
// registrable domain keeps apex/www/CMS aliases internal without another
// deployment flag, while Public Suffix List parsing prevents co.ke/co.uk-style
// sibling domains from being mistaken for subdomains of the site.
// Unconfigured means "no domain is first-party", not "assume some site":
// classification is written to the database as rel="nofollow", so guessing a
// brand here would either drop link equity on the real site or hand it to
// another deployment's domain. Over-nofollowing is the safe direction, and
// relative hrefs are unaffected.
function configuredInternalDomain(): string | null {
  return configuredPublicSiteDomain();
}

function isInternalHost(hostname: string): boolean {
  const internalDomain = configuredInternalDomain();
  if (!internalDomain) return false;
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  const linkedDomain = getDomain(normalized) ?? normalized;
  return linkedDomain === internalDomain;
}

function isExternalHttpHref(href: string | undefined): boolean {
  if (!href) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // Relative/rooted paths cannot leave the site.
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !isInternalHost(url.hostname);
}

export function cleanHtml(val: string | null | undefined): string | null {
  if (val == null) return null;
  const sanitized = sanitizeHtmlLib(val, {
    allowedTags: [
      'p', 'br', 'hr', 'span', 'div', 'blockquote', 'pre', 'code',
      'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'a', 'img', 'figure', 'figcaption',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'loading'],
      '*': ['class', 'id', 'colspan', 'rowspan'],
    },
    // Only safe URL schemes; drops javascript:, vbscript:, and data: URIs.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    // Force noopener/noreferrer on every link; external links additionally
    // get nofollow so editorial content never leaks link equity off-site.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          rel: isExternalHttpHref(attribs.href)
            ? 'nofollow noopener noreferrer'
            : 'noopener noreferrer',
        },
      }),
    },
  }).trim();
  return sanitized.length > 0 ? sanitized : null;
}

export const RICHTEXT_FIELDS: Record<string, string[]> = {
  'api::deal.deal': ['content'],
  'api::coupon.coupon': ['content'],
  'api::category.category': ['description'],
  'api::bank.bank': ['description'],
  // festiveOfferDescription is rendered raw like every other richtext field,
  // so it goes through the same allowlist. Listing it here is not optional:
  // an unlisted richtext field is stored exactly as the editor sent it.
  'api::brand.brand': ['description', 'festiveOfferDescription'],
  'api::store.store': ['description', 'festiveOfferDescription'],
};

const LEGAL_PAGE_UIDS = new Set([
  'api::privacy-policy-page.privacy-policy-page',
  'api::terms-and-conditions-page.terms-and-conditions-page',
]);

/** Sanitize (in place) every richtext field present in a write payload. */
export function sanitizeRichtextData(uid: string, data: any): void {
  if (!data || typeof data !== 'object') return;
  for (const field of RICHTEXT_FIELDS[uid] ?? []) {
    if (typeof data[field] === 'string') {
      data[field] = cleanHtml(data[field]);
    }
  }

  // Legal document HTML lives inside repeatable section components rather
  // than a top-level attribute. Sanitize every supplied section body before
  // Strapi persists the component rows.
  if (LEGAL_PAGE_UIDS.has(uid) && Array.isArray(data.sections)) {
    for (const section of data.sections) {
      if (typeof section?.body === 'string') {
        section.body = cleanHtml(section.body);
      }
    }
  }
}
