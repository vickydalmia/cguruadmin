"use strict";

const {
  reconcileContentContractAfterSchemaSync,
} = require("../content-contract-reconciliation");

/**
 * Seed missing entity media alt text from the entity's own name.
 *
 * Alt text is now required on every taxonomy entity, but it was optional (and
 * on categories, absent entirely) when this content was first imported: 156
 * stores, 46 brands and 3 banks had no `logo_alt`, and all 128 categories had
 * no `icon_alt` field at all. Without this, every one of those records fails
 * validation the first time an editor opens and saves it.
 *
 * The name is the same value the site ALREADY renders when the field is blank
 * (`getMediaAlt(media, name)` in the frontend, and the `?? name` fallback in
 * the directory service), so this changes no rendered output — it just moves
 * the fallback into the database where the required-field check can see it.
 *
 * TRADE-OFF, deliberate: filling these silences the "Needs attention" prompt
 * that would otherwise ask an editor to write better alt text than the bare
 * name. That is the intended call — a blocked save on 333 records is worse
 * than a generic-but-accurate alt — but genuinely descriptive alt text is
 * still worth authoring on the entities that matter most.
 *
 * Fill-only (`whereNull` + blank check), so an authored value is never
 * overwritten and re-running is a no-op. `btrim` catches whitespace-only
 * values, which the server's `isBlankText` also treats as missing.
 */
module.exports = {
  async up(knex) {
    await reconcileContentContractAfterSchemaSync(knex);
  },
};
