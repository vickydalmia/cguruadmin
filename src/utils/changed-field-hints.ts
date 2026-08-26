// Editor-facing hints derived from the changed-field rule tables
// (./changed-field-rules). Consumed by src/bootstrap/field-hints.ts;
// hint-coverage.test.ts fails when a rule ships without a hint.
import {
  SEO_COMPONENT_UID,
  SEO_RULES,
  TOP_LEVEL_RULES,
} from './changed-field-rules';

export type FieldHint = { uid: string; field: string; hint: string };
export type ComponentFieldHint = {
  componentUid: string;
  field: string;
  hint: string;
};

/**
 * Editor-facing hints for every TOP-LEVEL rule in this file, derived straight
 * from the rule table so the shown limit can never drift from the enforced
 * one. Consumed by src/bootstrap/field-hints.ts, which pins each hint into
 * the content-manager edit view as the field's grey description.
 */
export function changedFieldHints(): FieldHint[] {
  return TOP_LEVEL_RULES.map((rule) => ({
    uid: rule.uid,
    field: rule.path[0],
    hint: rule.hint,
  }));
}

/**
 * Hints for the shared.seo component rules. The component is embedded by nine
 * content types and its metadatas are stored once per COMPONENT, so these are
 * declared against SEO_COMPONENT_UID and show under the field everywhere the
 * component is edited — which matches how the rules are enforced.
 */
export function changedFieldSeoHints(): ComponentFieldHint[] {
  return SEO_RULES.map((rule) => ({
    componentUid: SEO_COMPONENT_UID,
    field: rule.path[1] as string,
    hint: rule.hint,
  }));
}
