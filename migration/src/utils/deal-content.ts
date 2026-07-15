import sanitizeHtmlLib from "sanitize-html";

import { cleanHtml } from "./sanitize.js";

/**
 * WordPress reused `post_content` as a scratch value on legacy Deal posts.
 * Only keep content that reads like a description; prices, coupon codes, and
 * structurally empty HTML must not create an empty Show Details disclosure.
 */
export function cleanDealContent(
  value: string | null | undefined,
): string | null {
  const html = cleanHtml(value);
  if (!html) return null;

  const plainText = sanitizeHtmlLib(html, {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = plainText.split(/\s+/u).filter(Boolean);

  return /\p{L}/u.test(plainText) && words.length >= 2 ? html : null;
}
