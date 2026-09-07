"use strict";

const sanitizeHtml = require("sanitize-html");

/**
 * Repair entity short descriptions the WordPress import stored verbatim.
 *
 * `shortDescription` is a plain `text` attribute, but the public site injects
 * it as HTML (entity hero, `set:html`). The legacy theme saved the field as
 * `<font size="2"><p>…` with neither tag closed — 311 of the 802 Singapore
 * terms, and the same theme wrote every other country. An unclosed FORMATTING
 * element is not contained by the element it is rendered into: the browser's
 * parser re-creates it around every later inline node in the document, so one
 * store page carried ~670 injected `<font>` elements inside coupon cards, flex
 * rows and headings, and rendered visibly broken next to a clean one.
 *
 * Every write now passes the field through the richtext allowlist
 * (src/utils/sanitize-richtext.ts), which drops presentational tags and
 * closes what is open. This migration applies the same repair to the rows
 * already stored, in every locale, draft and published alike, so the
 * database agrees with what a fresh import would have produced.
 *
 * Allowlist copied from sanitize-richtext.ts (compiled TypeScript cannot be
 * required from a migration). The one deliberate omission is the link `rel`
 * classification: existing `rel` values are kept as stored, and the write
 * pipeline re-derives them the next time an editor saves the record.
 * sanitize-html is idempotent on its own output, so re-running is a no-op
 * and already-clean rows are left byte-identical.
 */

const TABLES = ["stores", "brands", "categories", "banks"];
const COLUMN = "short_description";
const BATCH = 500;

const ALLOWLIST = {
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
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowProtocolRelative: false,
};

function cleanHtml(value) {
  const sanitized = sanitizeHtml(value, ALLOWLIST).trim();
  return sanitized.length > 0 ? sanitized : null;
}

/** The sequence of start/end tag names — the shape the browser will build. */
function tagSignature(html) {
  return (html.match(/<\/?[a-zA-Z][a-zA-Z0-9-]*/g) || []).map((tag) => tag.toLowerCase()).join(" ");
}

/**
 * Rewrite only when sanitizing changes the element structure — a dropped
 * `<font>`, a closed `<p>`. sanitize-html also normalizes entities
 * (`&nbsp;` to U+00A0, `&` to `&amp;`), and a clean row must not be rewritten
 * for that alone: byte changes here feed the translation fingerprints, so a
 * cosmetic rewrite of every Arabic-translated entity would queue needless
 * retranslation. Attribute-only differences are left to the next editor
 * save, where the write pipeline applies the full allowlist.
 */
function containedValue(stored) {
  const contained = cleanHtml(stored);
  if (contained === null || contained === stored) return null;
  return tagSignature(contained) === tagSignature(stored) ? null : contained;
}

async function containTable(knex, table) {
  if (!(await knex.schema.hasTable(table))) return 0;
  if (!(await knex.schema.hasColumn(table, COLUMN))) return 0;

  let updated = 0;
  let lastId = 0;
  for (;;) {
    // Only rows that contain markup can need repair; plain text is skipped
    // without being rewritten.
    const rows = await knex(table)
      .select("id", COLUMN)
      .where("id", ">", lastId)
      .where(COLUMN, "like", "%<%")
      .orderBy("id", "asc")
      .limit(BATCH);
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = Number(row.id);
      const stored = row[COLUMN];
      if (typeof stored !== "string") continue;
      // The field is required: a value that sanitizes to nothing is left for
      // an editor rather than blanked here.
      const contained = containedValue(stored);
      if (contained === null) continue;
      await knex(table).where({ id: row.id }).update({ [COLUMN]: contained });
      updated += 1;
    }
  }
  return updated;
}

module.exports = {
  async up(knex) {
    const result = {};
    for (const table of TABLES) {
      result[table] = await containTable(knex, table);
    }
    const total = Object.values(result).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      console.info(
        `[contain-entity-short-descriptions] repaired ${total} short description(s): ${JSON.stringify(result)}`,
      );
    }
  },
  cleanHtml,
  containedValue,
};
