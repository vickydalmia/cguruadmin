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
    // Force noopener/noreferrer on links that open a new tab.
    transformTags: {
      a: sanitizeHtmlLib.simpleTransform('a', { rel: 'noopener noreferrer' }),
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

/** Sanitize (in place) every richtext field present in a write payload. */
export function sanitizeRichtextData(uid: string, data: any): void {
  if (!data || typeof data !== 'object') return;
  for (const field of RICHTEXT_FIELDS[uid] ?? []) {
    if (typeof data[field] === 'string') {
      data[field] = cleanHtml(data[field]);
    }
  }
}
