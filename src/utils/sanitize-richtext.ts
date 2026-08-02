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

// couponzguru.com and every subdomain (www, beta, cms) count as internal;
// anything else that resolves to an absolute http(s) URL is external and gets
// rel="nofollow" added automatically — the editor has no per-link rel control
// (TipTap always emits dofollow), so the sanitizer owns the policy. The
// transform is a pure function of href, so sanitized output stays idempotent.
const INTERNAL_HOST_PATTERN = /(^|\.)couponzguru\.com$/iu;

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
  return !INTERNAL_HOST_PATTERN.test(url.hostname);
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
  'api::brand.brand': ['description'],
  'api::store.store': ['description'],
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
