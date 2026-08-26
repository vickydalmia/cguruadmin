/**
 * Finds the required fields an already-saved record is still missing, so the
 * "Fix before saving" panel can list them THE MOMENT the record is opened —
 * rather than after the editor hits Save and the write is rejected.
 *
 * WHY THIS EXISTS: `required: true` gets the admin to draw an asterisk and to
 * block a submit, but it says nothing until a submit happens. Most legacy rows
 * here predate newer required rules (for example, 205 entities are missing alt
 * text), so an editor opening one has no idea anything is wrong until their
 * save bounces. This turns that into an up-front checklist.
 *
 * Derived from the SAME schema that draws the asterisk (the content-manager's
 * contentType attributes), never a hardcoded list — a field that gains or
 * loses `required` in schema.json changes both at once, with nothing to keep
 * in step.
 *
 * Blankness matches the server's `isBlankText`/`isBlankMedia`
 * (src/utils/text-field-validation.ts): whitespace-only counts as missing, and
 * the cleared-media widget shapes count as empty. Numbers are present-or-not —
 * 0 is a real value, never "missing".
 */

import { humanizeField } from './humanize-field';

export type PendingField = {
  /** Form path, e.g. ['websiteUrl'] or ['seo', 'metaTitle']. */
  path: string[];
  label: string;
};

type Attribute = {
  type?: string;
  required?: boolean;
  component?: string;
  repeatable?: boolean;
};

type Schema = { attributes?: Record<string, Attribute> } | undefined;

function isBlankMediaValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const patch = value as { set?: unknown; connect?: unknown };
    if (Array.isArray(patch.set)) return patch.set.length === 0;
    if (Array.isArray(patch.connect)) return patch.connect.length === 0;
    return false;
  }
  return false;
}

function isBlankValue(attribute: Attribute, value: unknown): boolean {
  const type = attribute.type;
  if (type === 'media' || type === 'relation') return isBlankMediaValue(value);
  if (value === undefined || value === null) return true;
  // A number (including 0) or boolean false is a real answer, not a blank.
  if (typeof value === 'number' || typeof value === 'boolean') return false;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Required-but-blank fields in `values`, walking one level into non-repeatable
 * components so `seo.metaTitle` is reported at its real form path (which is
 * what the admin needs to highlight it).
 *
 * Repeatable components and dynamic zones are skipped: a required field inside
 * row 3 of a list is a different UX problem, and reporting "faqs #3 › question"
 * from a panel that cannot scroll to it would be noise.
 */
export function pendingRequiredFields(
  contentType: Schema,
  components: Record<string, Schema> | undefined,
  values: Record<string, unknown> | undefined,
): PendingField[] {
  const attributes = contentType?.attributes;
  if (!attributes) return [];

  const data = values ?? {};
  const pending: PendingField[] = [];

  for (const [name, attribute] of Object.entries(attributes)) {
    if (!attribute || typeof attribute !== 'object') continue;

    if (attribute.type === 'component' && !attribute.repeatable) {
      const child = attribute.component ? components?.[attribute.component] : undefined;
      const childAttributes = child?.attributes;
      if (!childAttributes) continue;

      const nested = data[name];
      // An absent optional component is only a problem once it has required
      // fields AND the editor has started filling it in — but a component that
      // is itself required, or one already present, must be complete.
      const nestedValues =
        nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : {};
      const componentPresent = nested != null;
      if (!componentPresent && !attribute.required) {
        // Still report its required children: the server enforces them on
        // create, so an untouched empty SEO section is a real blocker.
        for (const [childName, childAttribute] of Object.entries(childAttributes)) {
          if (!childAttribute?.required) continue;
          pending.push({
            path: [name, childName],
            label: `${humanizeField(name)} › ${humanizeField(childName)}`,
          });
        }
        continue;
      }

      for (const [childName, childAttribute] of Object.entries(childAttributes)) {
        if (!childAttribute?.required) continue;
        if (!isBlankValue(childAttribute, nestedValues[childName])) continue;
        pending.push({
          path: [name, childName],
          label: `${humanizeField(name)} › ${humanizeField(childName)}`,
        });
      }
      continue;
    }

    if (!attribute.required) continue;
    if (!isBlankValue(attribute, data[name])) continue;
    pending.push({ path: [name], label: humanizeField(name) });
  }

  return pending;
}
