/**
 * Heuristic extraction of the offer badge (`offerText`) and the cashback /
 * bank-offer texts (`cashbackText`, `bankOfferText`) from a coupon/deal's
 * free-text title and content. Best-effort only — titles are human-written, so
 * callers should treat the result as a backfill default that editors can
 * correct in the admin.
 *
 * Scanning order is title first, then content; the first confident match wins
 * for the badge. Cashback/bank spans are stripped before the badge is computed
 * so e.g. "15% Cashback" is never mistaken for the main "15% OFF" badge.
 */

/** Collapse HTML + whitespace to a single plain-text line for scanning. */
function toPlain(val: string | null | undefined): string {
  if (!val) return "";
  return val
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip a rupee/percentage amount down to plain digits: "1,250" -> "1250". */
function digits(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

// Cashback / bank-offer patterns (global — a title can carry several pills).
const CASHBACK_RE = /(\d{1,3})\s*%\s*cash\s?back/gi;
const BANK_PCT_RE = /(\d{1,3})\s*%\s*bank\s*(?:off|discount|offer)/gi;
const BANK_BARE_RE = /\bbank\s*(?:offer|off)\b/gi;

export interface CashbackFields {
  /** e.g. "15% Cashback", or null when none found. */
  cashbackText: string | null;
  /** e.g. "12% Bank OFF" (or bare "Bank OFF"), or null when none found. */
  bankOfferText: string | null;
}

// Non-global variants for single first-match extraction (no lastIndex state).
const CASHBACK_ONE = /(\d{1,3})\s*%\s*cash\s?back/i;
const BANK_PCT_ONE = /(\d{1,3})\s*%\s*bank\s*(?:off|discount|offer)/i;
const BANK_BARE_ONE = /\bbank\s*(?:offer|off)\b/i;

/**
 * Extract the cashback text and the bank-offer text as two separate strings,
 * scanning title first then content. Each is the first confident match, or
 * null. A bare "Bank Offer" (no percentage) is only used when no "X% Bank OFF"
 * was found.
 */
export function extractCashbackFields(
  title: string | null | undefined,
  content?: string | null | undefined
): CashbackFields {
  let cashbackText: string | null = null;
  let bankOfferText: string | null = null;

  const texts = [toPlain(title), toPlain(content)];

  for (const text of texts) {
    if (!text) continue;
    if (!cashbackText) {
      const m = text.match(CASHBACK_ONE);
      if (m) cashbackText = `${m[1]}% Cashback`;
    }
    if (!bankOfferText) {
      const m = text.match(BANK_PCT_ONE);
      if (m) bankOfferText = `${m[1]}% Bank OFF`;
    }
  }

  if (!bankOfferText) {
    for (const text of texts) {
      if (text && BANK_BARE_ONE.test(text)) {
        bankOfferText = "Bank OFF";
        break;
      }
    }
  }

  return { cashbackText, bankOfferText };
}

/** Remove cashback/bank spans so they can't leak into the main badge. */
function stripCashbackSpans(text: string): string {
  return text
    .replace(CASHBACK_RE, " ")
    .replace(BANK_PCT_RE, " ")
    .replace(BANK_BARE_RE, " ");
}

/**
 * The offer badge, split into its three render slots:
 * [prefix, value, suffix] — e.g. ["UPTO", "50%", "OFF"], ["EXTRA", "18%",
 * "OFF"], ["FLAT", "₹625", "OFF"], ["", "18%", "OFF"], ["", "FLAT", "OFF"].
 * The prefix is "" when the title carries no qualifier word.
 */
export type OfferParts = [string, string, string];

/** Normalise a qualifier word to its canonical uppercase badge form. */
function normQualifier(raw: string | undefined): string {
  if (!raw) return "";
  const c = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (c === "upto") return "UPTO";
  if (c === "flat") return "FLAT";
  if (c === "extra") return "EXTRA";
  return raw.trim().toUpperCase();
}

/** First-match-wins badge patterns, highest priority first. */
function matchOffer(text: string): OfferParts | null {
  let m: RegExpMatchArray | null;

  // Qualifier (UPTO / FLAT / EXTRA) immediately before a percentage.
  if ((m = text.match(/\b(up\s?to|flat|extra)\s+(\d{1,3})\s*%/i)))
    return [normQualifier(m[1]), `${m[2]}%`, "OFF"];
  // Qualifier immediately before a rupee amount.
  if ((m = text.match(/\b(up\s?to|flat|extra)\s+(?:rs\.?|₹|inr)\s*([\d,]+)/i)))
    return [normQualifier(m[1]), `₹${digits(m[2])}`, "OFF"];
  // Percentage followed (within a short gap) by "off"/"discount", with an
  // optional qualifier word right before it — so "Extra 18% (New Users) Off"
  // keeps the EXTRA prefix and "18% Off" resolves to ["", "18%", "OFF"].
  if (
    (m = text.match(
      /\b(up\s?to|flat|extra)?\s*(\d{1,3})\s*%[^%]{0,25}?\b(?:off|discount)\b/i
    ))
  )
    return [normQualifier(m[1]), `${m[2]}%`, "OFF"];
  // Rupee amount followed by "off".
  if ((m = text.match(/(?:rs\.?|₹|inr)\s*([\d,]+)\s*off/i)))
    return ["", `₹${digits(m[1])}`, "OFF"];
  // Bare percentage (last-resort).
  if ((m = text.match(/(\d{1,3})\s*%/))) return ["", `${m[1]}%`, "OFF"];
  // "Flat" with no amount at all.
  if (/\bflat\b/i.test(text)) return ["", "FLAT", "OFF"];

  return null;
}

/**
 * Extract the primary offer badge as a short text string of at most 3 words,
 * e.g. "UPTO 50% OFF", "EXTRA 18% OFF", "FLAT ₹625 OFF", "18% OFF", "FLAT OFF".
 * The qualifier is dropped when the title carries none. Returns null when
 * nothing confidently matches (the editor then fills it in manually). Scans
 * title first, then content. The API splits this into an array of words on the
 * way out; the stored value stays plain text for easy admin editing.
 */
export function extractOfferText(
  title: string | null | undefined,
  content?: string | null | undefined
): string | null {
  for (const raw of [title, content]) {
    const text = stripCashbackSpans(toPlain(raw));
    if (!text) continue;
    const parts = matchOffer(text);
    if (parts) return parts.filter(Boolean).join(" ");
  }
  return null;
}
