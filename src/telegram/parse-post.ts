/// <reference lib="es2022.intl" />
import type { TelegramMessageEntity } from './bot-api';

// Best-effort projection of a free-text channel post onto the storefront's
// deal card. Nothing here is authoritative: a field the text does not carry
// is null and the card simply omits it. Editors can correct the stored result
// in Content Manager › Telegram Posts.

export type ParsedTelegramPost = {
  title: string | null;
  salePrice: number | null;
  mrp: number | null;
  discountLabel: string | null;
  ctaUrl: string | null;
  storeDomain: string | null;
};

const TITLE_MAX_LENGTH = 160;
const AMOUNT_PATTERN =
  /(?:₹|Rs\.?|INR|AED|SGD|S\$|USD|US\$|\$|RM|MYR|PHP|₱)\s*([\d]{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/gi;
const PERCENT_OFF_PATTERN = /\b(flat|extra|upto|up to)?\s*(\d{1,2}(?:\.\d)?)\s*%\s*(?:off|discount)\b/i;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

type Amount = { value: number; index: number; end: number };

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function firstLineTitle(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    // Emoji_Component includes ordinary ASCII digits, # and *. Remove whole
    // emoji graphemes instead so discounts and model numbers survive.
    let prefixLength = 0;
    for (const { segment } of titleSegments.segment(line)) {
      if (!/^[\s•\-–—>|]+$/u.test(segment)
        && !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(segment)) break;
      prefixLength += segment.length;
    }
    const cleaned = collapseWhitespace(line.slice(prefixLength).replace(/^(?:#{1,6}|\*+)\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1'));
    if (!cleaned) continue;
    return cleaned.length > TITLE_MAX_LENGTH ? `${cleaned.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : cleaned;
  }
  return null;
}

const titleSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function amounts(text: string): Amount[] {
  const found: Amount[] = [];
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    found.push({ value, index: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return found;
}

function struckRanges(entities: readonly TelegramMessageEntity[]): Array<[number, number]> {
  return entities
    .filter((entity) => entity.type === 'strikethrough')
    .map((entity) => [entity.offset, entity.offset + entity.length]);
}

function insideAny(amount: Amount, ranges: readonly [number, number][]): boolean {
  return ranges.some(([start, end]) => amount.index >= start && amount.end <= end);
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/[)\].,!?]+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function firstUrl(text: string, entities: readonly TelegramMessageEntity[]): string | null {
  // Entities arrive in document order; a text_link carries its href, a url
  // entity is the visible text itself. Offsets are UTF-16 code units, which
  // is exactly what String#slice indexes, so no conversion is needed.
  for (const entity of entities) {
    if (entity.type === 'text_link') {
      const url = safeHttpUrl(entity.url);
      if (url) return url;
    } else if (entity.type === 'url') {
      const url = safeHttpUrl(text.slice(entity.offset, entity.offset + entity.length));
      if (url) return url;
    }
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = safeHttpUrl(match[0]);
    if (url) return url;
  }
  return null;
}

function discount(text: string, salePrice: number | null, mrp: number | null): string | null {
  const explicit = PERCENT_OFF_PATTERN.exec(text);
  if (explicit) {
    const prefix = explicit[1]?.toLowerCase();
    const label = prefix === 'flat' ? 'Flat ' : prefix === 'extra' ? 'Extra ' : prefix ? 'Up to ' : '';
    return `${label}${explicit[2]}% OFF`;
  }
  if (salePrice != null && mrp != null && mrp > salePrice) {
    const percent = Math.round((1 - salePrice / mrp) * 100);
    return percent >= 1 && percent <= 99 ? `${percent}% OFF` : null;
  }
  return null;
}

export function parseTelegramPost(
  rawText: string | null | undefined,
  rawEntities: readonly TelegramMessageEntity[] | null | undefined,
): ParsedTelegramPost {
  const text = typeof rawText === 'string' ? rawText : '';
  const entities = Array.isArray(rawEntities) ? rawEntities : [];

  // Cashback, delivery charges and minimum spend are not product prices.
  const found = amounts(text).filter(amount => {
    const before = text.slice(Math.max(0, amount.index - 35), amount.index);
    const after = text.slice(amount.end, amount.end + 24);
    return !/\b(?:cashback|shipping|delivery|minimum spend|min spend|save|saving|extra discount)\s*(?:of\s*)?[:@=-]?\s*$/i.test(before)
      && !/^\s*(?:cashback|shipping|delivery|extra discount)\b/i.test(after);
  });
  const struck = struckRanges(entities);
  const struckAmounts = found.filter((amount) => insideAny(amount, struck));
  const markedMrp = (amount: Amount) => insideAny(amount, struck)
    || /\b(?:mrp|worth|was|list price|original price)\s*[:=-]?\s*$/i.test(text.slice(Math.max(0, amount.index - 30), amount.index));
  const plainAmounts = found.filter((amount) => !markedMrp(amount));

  let salePrice: number | null = plainAmounts[0]?.value ?? null;
  let mrp: number | null = struckAmounts[0]?.value ?? found.find(markedMrp)?.value ?? null;
  if (salePrice != null && mrp != null && mrp <= salePrice) mrp = null;

  const ctaUrl = firstUrl(text, entities);
  return {
    title: firstLineTitle(text),
    salePrice,
    mrp,
    discountLabel: discount(text, salePrice, mrp),
    ctaUrl,
    storeDomain: domainOf(ctaUrl),
  };
}
