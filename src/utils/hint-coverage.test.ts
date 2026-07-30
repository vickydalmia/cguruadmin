import { describe, expect, it } from 'vitest';
import {
  changedFieldHints,
  changedFieldSeoHints,
  SEO_COMPONENT_UID,
} from './changed-field-validation';
import { TEXT_FIELD_RULES, textFieldHints } from './text-field-validation';
// src/index.ts is the merge chokepoint: it derives the editor-facing hints
// from the two rule tables above (plus a hand-declared mirror table for
// validators that live elsewhere) and pins them into the content-manager
// config at boot. Importing it here proves the merged tables really contain
// every enforced field — a rule added without a hint, or a hint dropped from
// the merge, fails THIS file loudly instead of silently shipping a field
// with no guidance.
import {
  COMPONENT_FIELD_DESCRIPTIONS,
  CONTENT_TYPE_FIELD_HINTS,
} from '../index';

describe('hint sources', () => {
  it('every changed-field top-level rule has a non-empty hint', () => {
    const hints = changedFieldHints();
    expect(hints.length).toBeGreaterThan(0);
    for (const { uid, field, hint } of hints) {
      expect(hint.trim(), `${uid}.${field} needs a hint`).not.toBe('');
    }
  });

  it('every changed-field seo rule has a non-empty hint on shared.seo', () => {
    const hints = changedFieldSeoHints();
    expect(hints.length).toBeGreaterThan(0);
    for (const { componentUid, field, hint } of hints) {
      expect(componentUid).toBe(SEO_COMPONENT_UID);
      expect(hint.trim(), `${componentUid}.${field} needs a hint`).not.toBe('');
    }
  });

  it('every text-field rule derives a non-empty hint', () => {
    const hints = textFieldHints();
    // 1:1 with the rule table — a new rule cannot dodge hint derivation.
    expect(hints.length).toBe(TEXT_FIELD_RULES.length);
    for (const { uid, field, componentUid, hint } of hints) {
      expect(
        hint.trim(),
        `${componentUid ?? uid}.${field} needs a hint`
      ).not.toBe('');
    }
    // Container rules must resolve to a known component uid, or the hint
    // would be silently unroutable.
    for (const entry of hints) {
      const rule = TEXT_FIELD_RULES.find(
        (r) => r.uid === entry.uid && r.field === entry.field
      );
      if (rule?.container) {
        expect(
          entry.componentUid,
          `${rule.uid}.${rule.field}: container "${rule.container}" has no component uid mapping`
        ).toBeTruthy();
      }
    }
  });
});

describe('index.ts merged hint map', () => {
  it('covers every content-type field the two rule tables enforce', () => {
    const topLevel = [
      ...changedFieldHints(),
      ...textFieldHints().filter((entry) => !entry.componentUid),
    ];
    expect(topLevel.length).toBeGreaterThan(0);
    for (const { uid, field, hint } of topLevel) {
      const merged = CONTENT_TYPE_FIELD_HINTS[uid]?.[field];
      expect(merged, `no merged hint for ${uid}.${field}`).toBeTruthy();
      // The merge concatenates sentences, so the derived hint must survive
      // verbatim inside the final description.
      expect(merged, `merged hint for ${uid}.${field} lost "${hint}"`).toContain(
        hint
      );
    }
  });

  it('covers every component field the two rule tables enforce', () => {
    const componentLevel = [
      ...changedFieldSeoHints(),
      ...textFieldHints()
        .filter((entry) => entry.componentUid)
        .map((entry) => ({
          componentUid: entry.componentUid as string,
          field: entry.field,
          hint: entry.hint,
        })),
    ];
    expect(componentLevel.length).toBeGreaterThan(0);
    for (const { componentUid, field } of componentLevel) {
      // An explicit hand-written description (e.g. shared.seo.canonicalUrl's
      // HTML warning) wins over the derived hint, so only presence is
      // asserted — the field must carry SOME description.
      const description = COMPONENT_FIELD_DESCRIPTIONS[componentUid]?.[field];
      expect(
        description?.trim(),
        `no component description for ${componentUid}.${field}`
      ).toBeTruthy();
    }
  });

  it('keeps hints for the fields whose validators live outside the tables', () => {
    // Hand-declared mirrors in src/index.ts (VALIDATOR_MIRROR_HINTS) for
    // offer-field-validation, offer-lifecycle-validation,
    // coupon-type-consistency, redirect-validation and identity-validation.
    // Removing one from the table breaks this list.
    const expected: Array<[string, string]> = [
      ...['api::coupon.coupon', 'api::deal.deal'].flatMap((uid): Array<[string, string]> => [
        [uid, 'offerText'],
        [uid, 'cashbackText'],
        [uid, 'bankOfferText'],
        [uid, 'prepaidText'],
        [uid, 'scheduledAt'],
        [uid, 'expiresAt'],
        [uid, 'publishedOn'],
      ]),
      ['api::coupon.coupon', 'code'],
      ['api::coupon.coupon', 'uniqueCouponPool'],
      ['api::redirect.redirect', 'from'],
      ['api::redirect.redirect', 'to'],
      ...['store', 'brand', 'category', 'bank'].flatMap(
        (name): Array<[string, string]> => [
          [`api::${name}.${name}`, 'name'],
          [`api::${name}.${name}`, 'slug'],
        ]
      ),
    ];
    for (const [uid, field] of expected) {
      expect(
        CONTENT_TYPE_FIELD_HINTS[uid]?.[field]?.trim(),
        `no merged hint for ${uid}.${field}`
      ).toBeTruthy();
    }
  });
});
