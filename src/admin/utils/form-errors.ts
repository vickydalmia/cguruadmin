// ---------------------------------------------------------------------------
// Form-error flattening for ValidationProblemsPanel (which runs on EVERY
// content type). Client-side checks and the server-side validators put their
// errors into the same nested form-errors state
// ({ section: { items: [{ field: 'msg' }] } }); these helpers flatten that
// into a human list — with the numbered homepage/DOTD section names where
// those apply — so editors see exactly WHERE the save failed instead of
// hunting through every section.
// ---------------------------------------------------------------------------
import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
} from '../../constants/homepage-sections';
import {
  DOTD_SECTION_LABELS,
  DOTD_UID,
} from '../../constants/deal-of-the-day-sections';
import { HOMEPAGE_IMAGE_RULES } from '../../constants/homepage-images';
import { humanizeFieldLower } from './humanize-field';

const SECTION_LABEL_BY_MODEL: Record<string, Record<string, string>> = {
  [HOMEPAGE_UID]: Object.fromEntries(
    HOMEPAGE_SECTION_LABELS.map(({ attr, label }) => [attr, label])
  ),
  [DOTD_UID]: Object.fromEntries(
    DOTD_SECTION_LABELS.map(({ attr, label }) => [attr, label])
  ),
};

// Client-side (pre-save) errors are stored as react-intl message descriptors
// ({ id, defaultMessage, values? }), server-side ones as plain strings — the
// flattener must treat descriptors as leaves, not nested error objects.
type MessageDescriptorLike = {
  id: string;
  defaultMessage?: string;
  values?: Record<string, unknown>;
};

const isMessageDescriptor = (node: unknown): node is MessageDescriptorLike =>
  typeof node === 'object' &&
  node !== null &&
  !Array.isArray(node) &&
  typeof (node as MessageDescriptorLike).id === 'string' &&
  typeof (node as MessageDescriptorLike).defaultMessage === 'string';

export type FlatError = {
  path: Array<string | number>;
  message: string | MessageDescriptorLike;
};

export const flattenFormErrors = (
  node: unknown,
  path: Array<string | number> = []
): FlatError[] => {
  if (node == null) return [];
  if (typeof node === 'string' || isMessageDescriptor(node)) {
    return path.length ? [{ path, message: node }] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child, index) =>
      child == null ? [] : flattenFormErrors(child, [...path, index])
    );
  }
  if (typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) =>
      flattenFormErrors(value, [...path, key])
    );
  }
  return [];
};

// ['newlyAdded','items',1,'cardImage'] -> "7 · Fresh Drops … › items #2 › card image"
export const describeErrorLocation = (
  path: Array<string | number>,
  model: string
): string => {
  const parts: string[] = [];
  path.forEach((segment, index) => {
    if (typeof segment === 'number') {
      parts[parts.length - 1] = `${parts[parts.length - 1] ?? ''} #${segment + 1}`;
      return;
    }
    parts.push(
      index === 0
        ? SECTION_LABEL_BY_MODEL[model]?.[segment] ?? humanizeFieldLower(segment)
        : humanizeFieldLower(segment)
    );
  });
  return parts.join(' › ');
};

// "newlyAdded.items[].cardImage" rule paths, keyed without indices so an error
// path like newlyAdded.items.1.cardImage can look up its size requirement.
const IMAGE_RULE_BY_PATH = new Map(
  // Strip EVERY '[]' (string replace would only strip the first): the lookup
  // key below drops all numeric segments, so a rule path with two repeatable
  // levels would otherwise never match.
  HOMEPAGE_IMAGE_RULES.map((rule) => [rule.path.replace(/\[\]/g, ''), rule])
);

export const imageHintFor = (path: Array<string | number>): string | null => {
  const key = path.filter((segment) => typeof segment === 'string').join('.');
  const rule = IMAGE_RULE_BY_PATH.get(key);
  return rule ? `Upload the ${rule.label} — exactly ${rule.width}×${rule.height} px.` : null;
};
