/**
 * Heuristic extraction of the offer badge (`offerText`) and the cashback /
 * bank-offer / prepaid texts (`cashbackText`, `bankOfferText`, `prepaidText`)
 * from a coupon/deal's free-text title and content. Best-effort only — titles
 * are human-written, so callers should treat the result as a backfill default
 * that editors can correct in the admin.
 *
 * Scanning order is title first, then content; the first confident match wins
 * for the badge. Cashback/bank/prepaid spans are stripped before the badge is
 * computed so e.g. "10% Bank OFF" is never mistaken for the main "10% OFF"
 * badge.
 *
 * Tuned against the real catalog: recognises UPTO/FLAT/EXTRA/MIN qualifiers,
 * ₹ and $ amounts, currency cashback, and "save X%"; requires an
 * off/discount/save/qualifier
 * context so a bare "100% Match/Free/Whey" or a stray body-text "%" never
 * becomes a badge. Bank offers must carry a number (percent or currency
 * amount) — no bare "Bank OFF".
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

// Currency and qualifier fragments, shared across patterns.
// `S$` / `SGD` (Singapore dollar) are recognised as their own marker. The
// lookbehind keeps `US$10` and `Gets$5` matching as a plain `$` exactly as
// before, so India/USA/UAE titles produce the same badges.
const CUR = String.raw`(?:rs\.?|₹|inr|usd|(?<![a-z])s\$|sgd|\$)`;
const QUAL = String.raw`up\s?to|flat|extra|additional|min(?:imum)?\.?`;
const PCT = String.raw`\d{1,3}(?:\.\d+)?`; // allow decimals: 19.2%
// Optional "-Y" / "to Y" tail so a range ("40-60%", "30 To 80%") keeps the
// FIRST number: "Flat 40-60% Off" -> "FLAT 40% OFF".
const RANGE_TAIL = String.raw`(?:\s*(?:-|–|to)\s*${PCT})?`;
// Negative lookahead rejecting amounts scaled by lakh/crore/etc. — those are
// prize/credit sums ("Win Rs.5 Crore", "Credit Upto Rs.5 Lakh"), never a
// discount, and matching would truncate to the leading digit ("₹5 OFF").
const NOT_SCALED = String.raw`(?!\s*(?:lakhs?|lacs?|crores?|cr|million|thousand|k)\b)`;
// A discount-confirming word within a short gap after the amount, so a bare
// price ("Plan Flat At Rs.599", "Win Rs.100") is never read as a discount.
const OFF_CTX = String.raw`[^%]{0,20}?\b(?:off|discount|save|saving)`;

type CurrencySymbol = "$" | "₹" | "S$";

/** "S$" for Singapore dollars, "$" for other dollar amounts, "₹" for the rest (rs/inr/₹). */
function currencySymbolFor(symbol: string): CurrencySymbol {
  if (/^s\$|sgd/i.test(symbol.trim())) return "S$";
  return /\$|usd/i.test(symbol) ? "$" : "₹";
}

function money(symbol: string, amount: string): string {
  return currencySymbolFor(symbol) + digits(amount);
}

/** Normalise a qualifier word to its canonical uppercase badge form. */
function normQualifier(raw: string | undefined): string {
  if (!raw) return "";
  const c = raw.trim().toLowerCase().replace(/\.$/, "").replace(/\s+/g, "");
  if (c === "upto") return "UPTO";
  if (c === "flat") return "FLAT";
  if (c === "extra" || c === "additional") return "EXTRA";
  if (c === "min" || c === "minimum") return "MIN";
  return raw.trim().toUpperCase();
}

// ── Cashback / bank offer ─────────────────────────────────────────────
// A single bank-name token (HDFC / ICICI / SBI …) may sit between the amount
// and the word "bank"; the offer must be confirmed by off/discount/offer.
const BANK_TAIL = String.raw`(?:[A-Za-z][A-Za-z.&]{1,9}\s+)?bank\s*(?:off|discount|offer)`;
const CASHBACK_ONE = new RegExp(String.raw`(${PCT})\s*%\s*cash\s?back`, "i");
// "Cashback of 13%" / "Cashback Of 10 %" — the percent trails the word.
const CASHBACK_TWO = new RegExp(
  String.raw`cash\s?back(?:\s+of)?\s*[:\-–]?\s*(${PCT})\s*%`,
  "i",
);
// Currency cashback is common in the USA source: "$10 Cashback",
// "Cashback of $10", and "Cashback USD 10". Keep the explicit source
// currency marker so a mixed-source anomaly is represented honestly rather
// than silently converted through the active profile.
const CASHBACK_MONEY_ONE = new RegExp(
  String.raw`(${CUR})\s*([\d,]+)\s*cash\s?back`,
  // Currency words and Cashback are intentionally case-insensitive, including
  // source variants such as "USD 15 Cashback" and "usd 15 cashback".
  "i",
);
const CASHBACK_MONEY_TWO = new RegExp(
  String.raw`cash\s?back(?:\s+of)?\s*[:\-–]?\s*(${CUR})\s*([\d,]+)`,
  "i",
);
const BANK_PCT_ONE = new RegExp(String.raw`(${PCT})\s*%\s*${BANK_TAIL}`, "i");
const BANK_RUPEE_ONE = new RegExp(String.raw`${CUR}\s*([\d,]+)\s*${BANK_TAIL}`, "i");
// Prepaid must be confirmed by off/discount/offer immediately after the word,
// so "10% Prepaid Bank Off" stays a bank offer and a bare "prepaid order"
// extracts nothing. No collision with BANK_TAIL, which requires "bank".
const PREPAID_TAIL = String.raw`prepaid\s*(?:off|discount|offer)`;
const PREPAID_PCT_ONE = new RegExp(String.raw`(${PCT})\s*%\s*${PREPAID_TAIL}`, "i");
const PREPAID_RUPEE_ONE = new RegExp(String.raw`${CUR}\s*([\d,]+)\s*${PREPAID_TAIL}`, "i");

// The benefit columns store the BARE AMOUNT only ("15%", "₹2000") — the public
// API appends the wording ("Cashback" / "Bank OFF" / "Prepaid OFF") on the way
// out (cguruadmin/src/utils/offer-text.ts), and the write validator rejects
// anything but an amount. An amountless perk ("Free Shipping On Prepaid
// Orders") therefore cannot be represented and is not extracted.
export interface CashbackFields {
  /** e.g. "15%" / "$10", or null when none found. */
  cashbackText: string | null;
  /** e.g. "12%" / "₹2000", or null when none found. */
  bankOfferText: string | null;
  /** e.g. "5%" / "₹100", or null when none found. */
  prepaidText: string | null;
}

/**
 * Extract the cashback, bank-offer and prepaid amounts, scanning title then
 * content. Each is the first confident match, or null. All three require a
 * number (percent or currency amount) — a bare "Bank Offer" or "prepaid" is
 * intentionally ignored.
 */
export function extractCashbackFields(
  title: string | null | undefined,
  content?: string | null | undefined,
  options: OfferExtractionOptions = {},
): CashbackFields {
  let cashbackText: string | null = null;
  let bankOfferText: string | null = null;
  let prepaidText: string | null = null;

  for (const text of [toPlain(title), toPlain(content)]) {
    if (!text) continue;
    if (!cashbackText) {
      const pct = text.match(CASHBACK_ONE) ?? text.match(CASHBACK_TWO);
      if (pct) {
        cashbackText = `${pct[1]}%`;
      } else {
        const currency =
          text.match(CASHBACK_MONEY_ONE) ?? text.match(CASHBACK_MONEY_TWO);
        if (currency) cashbackText = money(currency[1], currency[2]);
      }
    }
    if (!bankOfferText) {
      const pct = text.match(BANK_PCT_ONE);
      if (pct) {
        bankOfferText = `${pct[1]}%`;
      } else {
        const rupee = text.match(BANK_RUPEE_ONE);
        if (rupee) {
          const symbolMatch = text.match(BANK_RUPEE_ONE);
          bankOfferText = symbolMatch
            ? money(symbolMatch[0].match(new RegExp(CUR, "i"))?.[0] ?? defaultCurrencySymbol(options), rupee[1])
            : `${defaultCurrencySymbol(options)}${digits(rupee[1])}`;
        }
      }
    }
    if (!prepaidText) {
      const pct = text.match(PREPAID_PCT_ONE);
      if (pct) {
        prepaidText = `${pct[1]}%`;
      } else {
        const rupee = text.match(PREPAID_RUPEE_ONE);
        if (rupee) {
          const symbolMatch = text.match(PREPAID_RUPEE_ONE);
          prepaidText = symbolMatch
            ? money(symbolMatch[0].match(new RegExp(CUR, "i"))?.[0] ?? defaultCurrencySymbol(options), rupee[1])
            : `${defaultCurrencySymbol(options)}${digits(rupee[1])}`;
        }
      }
    }
  }

  return { cashbackText, bankOfferText, prepaidText };
}

// ── Offer badge ───────────────────────────────────────────────────────
/** Remove cashback/bank/prepaid spans so they can't leak into the main badge. */
function stripCashbackSpans(text: string): string {
  return text
    .replace(new RegExp(CASHBACK_ONE.source, "gi"), " ")
    .replace(new RegExp(CASHBACK_TWO.source, "gi"), " ")
    .replace(new RegExp(CASHBACK_MONEY_ONE.source, "gi"), " ")
    .replace(new RegExp(CASHBACK_MONEY_TWO.source, "gi"), " ")
    .replace(new RegExp(BANK_PCT_ONE.source, "gi"), " ")
    .replace(new RegExp(BANK_RUPEE_ONE.source, "gi"), " ")
    .replace(new RegExp(PREPAID_PCT_ONE.source, "gi"), " ")
    .replace(new RegExp(PREPAID_RUPEE_ONE.source, "gi"), " ");
}

/**
 * The offer badge split into [prefix, value, suffix] — the prefix is "" when
 * the title carries no qualifier word.
 */
export type OfferParts = [string, string, string];

/** First-match-wins badge patterns, highest priority first. */
export type OfferExtractionOptions = {
  currencyCode?: string;
};

function defaultCurrencySymbol(options: OfferExtractionOptions): CurrencySymbol {
  const code = options.currencyCode?.trim().toUpperCase();
  if (code === "USD") return "$";
  if (code === "SGD") return "S$";
  return "₹";
}

function matchOffer(text: string, options: OfferExtractionOptions): OfferParts | null {
  let m: RegExpMatchArray | null;

  if (/\bfree\s+shipping\b/iu.test(text)) return ["FREE", "SHIPPING", ""];
  if (/\b(?:buy\s+one\s+get\s+one|buy\s*1\s+get\s*1|bogo)\b/iu.test(text)) {
    return ["BOGO", "", ""];
  }
  if ((m = text.match(new RegExp(String.raw`\bstarting\s+(?:at|from)\s+(${CUR})\s*([\d,]+)`, "i")))) {
    return ["STARTING", money(m[1], m[2]), ""];
  }
  if ((m = text.match(new RegExp(String.raw`\bunder\s+(${CUR})\s*([\d,]+)`, "i")))) {
    return ["UNDER", money(m[1], m[2]), ""];
  }

  // Qualifier (UPTO/FLAT/EXTRA/MIN) immediately before a percentage. For a
  // range ("Min 30% To 80%", "Flat 40-60%") this captures the first number.
  if ((m = text.match(new RegExp(String.raw`\b(${QUAL})\s+(${PCT})${RANGE_TAIL}\s*%`, "i"))))
    return [normQualifier(m[1]), `${m[2]}%`, "OFF"];
  // Qualifier before a ₹/$ amount in a discount context ("Flat Rs.625 Off",
  // "Upto $20 Off"). Requires an off/discount word so a plain price ("Plan
  // Flat At Rs.599") is skipped, and rejects scaled sums ("Upto Rs.5 Lakh").
  if ((m = text.match(new RegExp(String.raw`\b(${QUAL})\s+(${CUR})\s*([\d,]+)${NOT_SCALED}${OFF_CTX}`, "i"))))
    return [normQualifier(m[1]), money(m[2], m[3]), "OFF"];
  // Percentage followed (within a short gap) by "off"/"discount"/"saving", with
  // an optional qualifier right before — "Extra 18% (New Users) Off" keeps EXTRA.
  if (
    (m = text.match(
      new RegExp(String.raw`\b(${QUAL})?\s*(${PCT})${RANGE_TAIL}\s*%[^%]{0,25}?\b(?:off|discount|saving)`, "i"),
    ))
  )
    return [normQualifier(m[1]), `${m[2]}%`, "OFF"];
  // "Save X%" — a discount even without the word "off".
  if ((m = text.match(new RegExp(String.raw`\bsave\s+(${PCT})\s*%`, "i"))))
    return ["", `${m[1]}%`, "OFF"];
  // A leading ₹/$ amount followed by "off" ("$40 Instant Off", "Rs.200 Off").
  if ((m = text.match(new RegExp(String.raw`(${CUR})\s*([\d,]+)${NOT_SCALED}\s*(?:instant\s+)?off`, "i"))))
    return ["", money(m[1], m[2]), "OFF"];
  // Amount with a TRAILING currency symbol then off ("Flat 30$ Off", "15$ Off").
  if ((m = text.match(new RegExp(String.raw`\b(${QUAL})?\s*([\d,]+)\s*\$\s*(?:instant\s+)?off`, "i"))))
    return [normQualifier(m[1]), money("$", m[2]), "OFF"];
  // Qualifier + bare amount (no %, no currency symbol) + off — ₹ assumed for
  // this India-first catalog ("Flat 250 Off" -> "FLAT ₹250 OFF"). Requiring a
  // qualifier + "off" (and the scale guard) keeps stray numbers out.
  if ((m = text.match(new RegExp(String.raw`\b(${QUAL})\s+([\d,]+)${NOT_SCALED}\s*(?:instant\s+)?off\b`, "i"))))
    return [normQualifier(m[1]), `${defaultCurrencySymbol(options)}${digits(m[2])}`, "OFF"];

  return null;
}

/**
 * Extract the primary offer badge as a short text string of at most 3 words,
 * e.g. "UPTO 50% OFF", "MIN 35% OFF", "EXTRA 18% OFF", "FLAT ₹625 OFF",
 * "$20 OFF". The qualifier is dropped when the title carries none. Returns null
 * when nothing confidently matches (a bare "%" that is not a discount never
 * qualifies). Scans title first, then content.
 */
export function extractOfferText(
  title: string | null | undefined,
  content?: string | null | undefined,
  options: OfferExtractionOptions = {},
): string | null {
  for (const raw of [title, content]) {
    const text = stripCashbackSpans(toPlain(raw));
    if (!text) continue;
    const parts = matchOffer(text, options);
    if (parts) return parts.filter(Boolean).join(" ");
  }
  return null;
}
