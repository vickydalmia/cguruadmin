/**
 * Sanitisation helpers for migration data.
 *
 * - `clean()`     – trim whitespace; collapse to null when empty.
 * - `cleanHtml()` – sanitize untrusted WP rich-text HTML (strip scripts etc.).
 * - `cleanSlug()` – trim, lowercase, strip anything that isn't [a-z0-9-].
 * - `cleanCode()` – trim whitespace from coupon/unique codes.
 */

import sanitizeHtmlLib from "sanitize-html";

function configuredInternalHosts(): string[] {
  const values = [
    process.env.SOURCE_INTERNAL_HOSTS,
    process.env.TARGET_INTERNAL_HOSTS,
  ]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase()];
      } catch {
        return [];
      }
    });
  // No fallback host: the rel rewrite is persisted into imported content, so
  // an unconfigured run must treat every absolute link as external rather than
  // grant first-party status to whichever brand happened to be in the code.
  return [...new Set(values)];
}

function isInternalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return configuredInternalHosts().some(
    (host) => normalized === host || normalized.endsWith(`.${host}`),
  );
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
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !isInternalHost(url.hostname);
}

/** Trim whitespace from a string value. Returns null if the result is empty. */
export function clean(val: string | null | undefined): string | null {
  if (val == null) return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Sanitize untrusted WordPress HTML before it is stored in Strapi and later
 * rendered on the public site via dangerouslySetInnerHTML. Allows common
 * formatting/links/images/tables but strips <script>/<style>/<iframe>, all
 * event-handler attributes, and javascript:/data: URLs. Returns null if the
 * result is empty after stripping.
 */
export function cleanHtml(val: string | null | undefined): string | null {
  if (val == null) return null;
  const sanitized = sanitizeHtmlLib(val, {
    allowedTags: [
      "p", "br", "hr", "span", "div", "blockquote", "pre", "code",
      "strong", "b", "em", "i", "u", "s", "sub", "sup", "mark", "small",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "dl", "dt", "dd",
      "a", "img", "figure", "figcaption",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "col", "colgroup",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "srcset", "sizes", "alt", "title", "width", "height", "loading"],
      "*": ["class", "id", "colspan", "rowspan"],
    },
    // Only safe URL schemes; drops javascript:, vbscript:, and data: URIs.
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowProtocolRelative: false,
    // Force noopener/noreferrer on every link; external links additionally
    // get nofollow so editorial content never leaks link equity off-site.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          rel: isExternalHttpHref(attribs.href)
            ? "nofollow noopener noreferrer"
            : "noopener noreferrer",
        },
      }),
    },
  }).trim();
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Sanitise a URL slug: trim, lowercase, replace whitespace/underscores with
 * hyphens, strip non-slug characters, collapse consecutive hyphens, and
 * strip leading/trailing hyphens.
 */
export function cleanSlug(val: string | null | undefined): string {
  if (!val) return "";
  return val
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")        // spaces/underscores → hyphen
    .replace(/[^a-z0-9-]/g, "")     // strip special chars
    .replace(/-{2,}/g, "-")         // collapse multiple hyphens
    .replace(/^-|-$/g, "");         // strip leading/trailing hyphens
}

/** Trim whitespace from a coupon code. Returns null if empty. */
export function cleanCode(val: string | null | undefined): string | null {
  if (val == null) return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}
