import { createRequire } from "node:module";

/**
 * Shared richtext registry for the fix scripts (fix-markdown-richtext,
 * fix-content-srcsets): the sanitizer + field list owned by the main package,
 * plus the table/column targets derived from them. Evaluating this module
 * throws on an unmapped uid, so both scripts still fail fast at import —
 * before main(), any DB connection, or the confirmation-flag check.
 */

// The main package owns the richtext allowlist and field registry; load it
// from there so the two can never drift. createRequire (not import) because
// the main package is CommonJS while this one is ESM — tsx compiles the TS
// across the boundary but Node's named-export detection can't see through it.
const require = createRequire(import.meta.url);
export const { cleanHtml, RICHTEXT_FIELDS } =
  require("../../../src/utils/sanitize-richtext") as {
    cleanHtml: (html: string) => string;
    RICHTEXT_FIELDS: Record<string, string[]>;
  };

// DB table per content-type uid (Strapi table names come from each schema's
// collectionName, not mechanical pluralization — so map explicitly). Derived
// from RICHTEXT_FIELDS so a richtext field added there cannot be silently
// skipped here: an unmapped uid fails fast below instead.
const TABLE_BY_UID: Record<string, string> = {
  "api::deal.deal": "deals",
  "api::coupon.coupon": "coupons",
  "api::category.category": "categories",
  "api::bank.bank": "banks",
  "api::brand.brand": "brands",
  "api::store.store": "stores",
};

export const RICHTEXT_TARGETS: Array<{ table: string; column: string }> =
  Object.entries(RICHTEXT_FIELDS).flatMap(([uid, fields]) => {
    const table = TABLE_BY_UID[uid];
    if (!table) {
      throw new Error(
        `RICHTEXT_FIELDS has "${uid}" but TABLE_BY_UID has no table for it — add the mapping`
      );
    }
    return fields.map((column) => ({ table, column }));
  });
