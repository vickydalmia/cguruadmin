import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const {
  OFFER_COUNTRY_REGISTRY,
  canonicalOfferCountries,
  parseOfferCountryTokens,
} = require("../../../src/constants/offer-countries") as typeof import("../../../src/constants/offer-countries");

type DetectionRule = {
  code: string;
  matches: (text: string) => boolean;
};

const contains =
  (pattern: RegExp) =>
  (text: string): boolean =>
    pattern.test(text);

function containsGeographicJordan(text: string): boolean {
  const pattern = /(?<![\p{L}\p{N}])Jordan(?:ian)?(?![\p{L}\p{N}])/giu;
  const neighboringGeography =
    /(?:U\.?\s*A\.?\s*E\.?|United\s+Arab\s+Emirates|K\.?\s*S\.?\s*A\.?|Saudi(?:\s+Arabia)?|Kuwait|Bahrain|Oman|Qatar|T[uü]rkiye|Turkey|Egypt|G\.?\s*C\.?\s*C\.?|M\.?\s*E\.?\s*N\.?\s*A\.?)\s*(?:,|&|and)\s*$/iu;
  const followingGeography =
    /^\s*(?:,|&|and)\s*(?:U\.?\s*A\.?\s*E\.?|United\s+Arab\s+Emirates|K\.?\s*S\.?\s*A\.?|Saudi(?:\s+Arabia)?|Kuwait|Bahrain|Oman|Qatar|T[uü]rkiye|Turkey|Egypt|G\.?\s*C\.?\s*C\.?|M\.?\s*E\.?\s*N\.?\s*A\.?)\b/iu;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const before = text.slice(Math.max(0, index - 140), index);
    const after = text.slice(
      index + match[0].length,
      index + match[0].length + 80,
    );
    const clauseStart = Math.max(
      before.lastIndexOf("."),
      before.lastIndexOf("!"),
      before.lastIndexOf("?"),
    );
    const clause = `${before.slice(clauseStart + 1)}${match[0]}${after}`;
    if (
      /\bbrands?\s+(?:included?|listed|include|like)\b/iu.test(clause) ||
      /\bair\s*$/iu.test(before) ||
      /^\s+(?:shoes?|sneakers?|footwear|collection|brand)\b/iu.test(after)
    ) {
      continue;
    }
    if (
      index === 0 ||
      neighboringGeography.test(before) ||
      followingGeography.test(after) ||
      /\b(?:countries?|destinations?|markets?|residents?|users?|worldwide)\b/iu.test(
        clause,
      ) ||
      /\b(?:in|within|across|throughout|from|to|for)\s+(?:the\s+)?$/iu.test(
        before,
      ) ||
      /^\s*(?:users?|residents?|market|only|stores?|website|site)\b/iu.test(
        after,
      )
    ) {
      return true;
    }
  }
  return false;
}

// Match explicit country/region wording only. Bare two-letter ISO codes are
// intentionally excluded: SA/OM/QA occur naturally in merchant/product copy
// and would create silent false tags. City names are also not countries — a
// travel offer mentioning Dubai is not necessarily restricted to the UAE.
const DETECTION_RULES: readonly DetectionRule[] = [
  {
    code: "AE",
    matches: contains(
      /(?<![\p{L}\p{N}])(?:U\.?\s*A\.?\s*E\.?|United\s+Arab\s+Emirates)(?![\p{L}\p{N}])/iu,
    ),
  },
  {
    code: "SA",
    matches: contains(
      /(?<![\p{L}\p{N}])(?:K\.?\s*S\.?\s*A\.?|Kingdom\s+of\s+Saudi\s+Arabia|Saudi(?:\s+Arabia)?)(?![\p{L}\p{N}])/iu,
    ),
  },
  {
    code: "KW",
    matches: contains(
      /(?<![\p{L}\p{N}])Kuwait(?:i)?(?![\p{L}\p{N}])/iu,
    ),
  },
  {
    code: "BH",
    matches: contains(
      /(?<![\p{L}\p{N}])Bahrain(?:i)?(?![\p{L}\p{N}])/iu,
    ),
  },
  {
    code: "OM",
    matches: contains(
      /(?<![\p{L}\p{N}])Oman(?:i)?(?![\p{L}\p{N}])/iu,
    ),
  },
  {
    code: "QA",
    matches: contains(
      /(?<![\p{L}\p{N}])Qatar(?:i)?(?![\p{L}\p{N}])/iu,
    ),
  },
  { code: "JO", matches: containsGeographicJordan },
  {
    code: "TR",
    matches: contains(
      /(?<![\p{L}\p{N}])(?:T[uü]rkiye|Turkey|Turkish)(?![\p{L}\p{N}])/iu,
    ),
  },
  {
    code: "EG",
    matches: contains(
      /(?<![\p{L}\p{N}])Egypt(?:ian)?(?![\p{L}\p{N}])/iu,
    ),
  },
  {
    code: "GCC",
    matches: contains(
      /(?<![\p{L}\p{N}])(?:G\.?\s*C\.?\s*C\.?|Gulf\s+Cooperation\s+Council)(?![\p{L}\p{N}])/iu,
    ),
  },
  // "Global Village" is a specific UAE attraction/merchant, not worldwide
  // validity. Other explicit global/worldwide wording maps to GLOBAL.
  {
    code: "GLOBAL",
    matches: contains(
      /(?<![\p{L}\p{N}])(?:worldwide|world-wide|globally|across\s+the\s+globe|global\s+(?:offers?|deals?|shipping|delivery|availability|coverage|flights?|hotels?|bookings?|destinations?|sales?))(?![\p{L}\p{N}])/iu,
    ),
  },
  {
    code: "MENA",
    matches: contains(
      /(?<![\p{L}\p{N}])(?:M\.?\s*E\.?\s*N\.?\s*A\.?|Middle\s+East\s+and\s+North\s+Africa)(?![\p{L}\p{N}])/iu,
    ),
  },
] as const;

function toPlainText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:nbsp|#160);/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&#0*38;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Extract every explicitly named, enabled offer country/region from title and
 * content. Returns the registry-ordered csv stored by Coupon/Deal, or null
 * when the text has no confident signal (untagged means valid everywhere).
 */
export function extractOfferCountries(
  title: string | null | undefined,
  content: string | null | undefined,
  enabledCountries: unknown,
): string | null {
  const enabled = new Set(parseOfferCountryTokens(enabledCountries));
  if (enabled.size === 0) return null;
  const text = `${toPlainText(title)} ${toPlainText(content)}`.trim();
  if (!text) return null;

  const matches = DETECTION_RULES.filter(
    ({ code, matches }) => enabled.has(code) && matches(text),
  ).map(({ code }) => code);
  const csv = canonicalOfferCountries(matches.join(","));
  return csv || null;
}

/**
 * Standalone phases 07/08 can run without preflight. Read and validate the
 * same profile value Phase 13 later persists so imported tags can never fall
 * outside the edit form's enabled Country Setup subset.
 */
export function loadProfileOfferCountries(file: string): string {
  const profile = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  const raw = profile.offerCountries;
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") {
    throw new Error(
      "Profile site configuration offerCountries must be a csv string",
    );
  }
  const known = new Set(OFFER_COUNTRY_REGISTRY.map(({ code }) => code));
  const unknown = parseOfferCountryTokens(raw).filter(
    (code) => !known.has(code),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Profile site configuration has unknown offer country code(s): ${unknown.join(", ")}`,
    );
  }
  return canonicalOfferCountries(raw);
}
