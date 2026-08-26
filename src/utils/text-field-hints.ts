// Editor-facing hint strings derived from TEXT_FIELD_RULES — the same table
// the write validator enforces, so the shown limit can never drift from the
// enforced one. Consumed by src/bootstrap/field-hints.ts, which pins each
// hint into the content-manager edit view as the field's grey description
// (component fields via the component config). hint-coverage.test.ts fails
// when a rule produces an empty hint.
import {
  BANK_UID,
  BRAND_UID,
  CATEGORY_UID,
  CONTAINER_COMPONENT_UIDS,
  COUPON_UID,
  DEAL_UID,
  STORE_UID,
  TEXT_FIELD_RULES,
  type TextFieldRule,
} from './text-field-rules';

export type TextFieldHint = {
  uid: string;
  field: string;
  /** Set when the field lives inside a component (container rules). */
  componentUid?: string;
  hint: string;
};

/** 'api::store.store' → 'stores' — for qualifying shared-component hints. */
const collectionLabel = (uid: string): string => {
  const name = uid.split('.').pop() ?? uid;
  return name.endsWith('y') ? `${name.slice(0, -1)}ies` : `${name}s`;
};

/**
 * Derive the editor-facing hint for one rule. Every enforced behaviour in this
 * file maps to a sentence: requiredNonBlank → "Required…", collapse/trim →
 * what happens to whitespace on save. Container rules are enforced per content
 * type but DISPLAYED on the shared component (visible on every embedding
 * type), so their required-ness is qualified with the type it applies to.
 */
export function textFieldHint(rule: TextFieldRule): string {
  const qualifier = rule.container ? ` for ${collectionLabel(rule.uid)}` : '';
  // Neither carries text, so the trim/collapse sentences below would be
  // meaningless — required-ness is the only thing worth saying.
  if (rule.kind === 'media' || rule.kind === 'number') {
    return rule.requiredNonBlank ? `Required${qualifier}.` : '';
  }
  const parts: string[] = [];
  if (rule.requiredNonBlank) parts.push(`Required${qualifier} — cannot be blank.`);
  if (rule.collapse) parts.push('Extra spaces are removed on save.');
  else if (rule.trim !== false && rule.kind !== 'richtext') {
    parts.push('Surrounding spaces are trimmed on save.');
  }
  return parts.join(' ');
}

/**
 * Editor-facing hints for every rule in this file, derived from the rule table
 * so the shown behaviour can never drift from the enforced one. Consumed by
 * src/bootstrap/field-hints.ts, which pins each hint into the content-manager
 * edit view as the
 * field's grey description (component fields via the component config).
 * hint-coverage.test.ts fails when a rule produces an empty hint.
 */
export function textFieldHints(): TextFieldHint[] {
  return TEXT_FIELD_RULES.map((rule) => ({
    uid: rule.uid,
    field: rule.field,
    ...(rule.container
      ? { componentUid: CONTAINER_COMPONENT_UIDS[rule.container] }
      : {}),
    hint: textFieldHint(rule),
  }));
}
