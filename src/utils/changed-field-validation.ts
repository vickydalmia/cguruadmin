// Write-time enforcement of the changed-field rule tables
// (./changed-field-rules): grandfathered comparisons — a rule only fires
// when the payload actually changes the field it protects. Hint derivation
// lives in ./changed-field-hints.
import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import {
  SEO_RULES,
  SEO_UIDS,
  TOP_LEVEL_RULES,
  type Rule,
} from './changed-field-rules';

type Problem = { path: string[]; message: string };

function rulesFor(uid: string): Rule[] {
  const rules = TOP_LEVEL_RULES.filter((rule) => rule.uid === uid);
  if (SEO_UIDS.has(uid)) {
    rules.push(...SEO_RULES.map((rule) => ({ ...rule, uid })));
  }
  return rules;
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.prototype.hasOwnProperty.call(value, key),
  );
}

function valueAt(data: unknown, path: Rule['path']): unknown {
  if (!data || typeof data !== 'object') return undefined;
  const first = Reflect.get(data, path[0]);
  if (path.length === 1) return first;
  return first && typeof first === 'object'
    ? Reflect.get(first, path[1])
    : undefined;
}

function cloneValueAt(
  data: unknown,
  stored: unknown,
  path: Rule['path'],
): unknown {
  if (path.length === 1) {
    return hasOwn(data, path[0]) ? valueAt(data, path) : valueAt(stored, path);
  }

  if (!hasOwn(data, path[0])) return valueAt(stored, path);
  const container = valueAt(data, [path[0]]);
  if (!container || typeof container !== 'object') return valueAt(data, path);
  return hasOwn(container, path[1])
    ? valueAt(data, path)
    : valueAt(stored, path);
}

function payloadTouches(data: unknown, path: Rule['path']): boolean {
  // Components are replaced as a unit. If `seo` is present, omission of one
  // nested key is itself a write (it clears that key).
  return hasOwn(data, path[0]);
}

function comparisonValue(rule: Rule, value: unknown): unknown {
  const compared = rule.compare ? rule.compare(value) : value;
  return compared === undefined || compared === '' ? null : compared;
}

function sameValue(rule: Rule, left: unknown, right: unknown): boolean {
  return Object.is(
    comparisonValue(rule, left),
    comparisonValue(rule, right),
  );
}

/**
 * Validate constraints that cannot safely live in a Strapi schema on a
 * populated database. Schema validators see the admin's full PUT and cannot
 * distinguish an untouched legacy value from a newly introduced defect.
 * This validator reads the stored row and only applies each rule on create,
 * clone, or an actual value change.
 *
 * STRICT ("clean as you touch"). When `strict` is true — a human admin write,
 * as computed once by the middleware via isHumanWrite — every rule is enforced
 * against the WHOLE effective record (payload merged over the stored row,
 * exactly as the clone path already does), and the grandfather escape hatch is
 * disabled, so a dirty untouched field blocks the save. When `strict` is false
 * — the status cron's partial updates — behaviour is UNCHANGED (grandfathered /
 * touched-only), so the cron keeps flipping statuses over dirty legacy rows.
 */
export async function validateChangedFields(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
  documentId?: string,
  strict: boolean = false,
  locale?: string,
  translationShortDescription = false,
): Promise<void> {
  if (!['create', 'update', 'clone'].includes(action)) return;
  if (!data || typeof data !== 'object') return;

  const isClone = action === 'clone';
  // strict and clone share the same "validate the full effective record"
  // machinery: read every rule's value from the payload merged over stored,
  // with no grandfathering.
  const effective = strict || isClone;
  const rules = rulesFor(uid).filter(
    (rule) => strict || isClone || payloadTouches(data, rule.path),
  );
  if (rules.length === 0) return;

  const isFreshCreate = action === 'create' || !documentId;
  let stored: unknown = null;

  if (!isFreshCreate) {
    const fields = [
      'documentId',
      ...rules
        .filter((rule) => rule.path.length === 1)
        .map((rule) => rule.path[0]),
    ];
    const seoFields = rules
      .filter((rule) => rule.path[0] === 'seo')
      .map((rule) => rule.path[1]);

    stored = await strapi.documents(uid as any).findOne({
      documentId,
      ...(locale ? { locale } : {}),
      fields: [...new Set(fields)] as any,
      ...(seoFields.length > 0
        ? {
            populate: {
              seo: { fields: [...new Set(seoFields)] },
            } as any,
          }
      : {}),
    });
  }
  if (isClone && documentId && !stored) return;

  const problems: Problem[] = [];
  for (const rule of rules) {
    // Arabic and other non-default languages must be useful and fit the
    // schema, but do not inherit English's editorial 160-character minimum.
    if (
      translationShortDescription &&
      rule.path.length === 1 &&
      rule.path[0] === 'shortDescription'
    ) {
      continue;
    }
    const incoming = effective
      ? cloneValueAt(data, stored, rule.path)
      : valueAt(data, rule.path);
    if (rule.valid(incoming)) continue;

    // Grandfather an unchanged legacy value on a non-strict update only. Strict
    // human writes must clean the whole record, so the escape hatch is off.
    if (
      !effective &&
      action === 'update' &&
      stored &&
      sameValue(rule, incoming, valueAt(stored, rule.path))
    ) {
      continue;
    }
    problems.push({ path: rule.path, message: rule.message });
  }

  if (problems.length === 0) return;
  const noun = problems.length === 1 ? 'problem' : 'problems';
  throw new errors.ValidationError(
    `This entry has ${problems.length} field ${noun} (the fields are highlighted ` +
      `in the form):\n• ${problems
        .map((problem) => `${problem.path.join('.')}: ${problem.message}`)
        .join('\n• ')}`,
    {
      errors: problems.map((problem) => ({
        path: problem.path,
        message: problem.message,
        name: 'ValidationError',
      })),
      problems: problems.map(
        (problem) => `${problem.path.join('.')}: ${problem.message}`,
      ),
    },
  );
}
