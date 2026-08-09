import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
} from '../../../constants/homepage-sections';
import {
  DOTD_SECTION_LABELS,
  DOTD_UID,
} from '../../../constants/deal-of-the-day-sections';
import { HOMEPAGE_IMAGE_RULES } from '../../../constants/homepage-images';

const SECTION_LABEL_BY_MODEL: Record<string, Record<string, string>> = {
  [HOMEPAGE_UID]: Object.fromEntries(
    HOMEPAGE_SECTION_LABELS.map(({ attr, label }) => [attr, label]),
  ),
  [DOTD_UID]: Object.fromEntries(
    DOTD_SECTION_LABELS.map(({ attr, label }) => [attr, label]),
  ),
};

export type MessageDescriptorLike = {
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
  path: Array<string | number> = [],
): FlatError[] => {
  if (node == null) return [];
  if (typeof node === 'string' || isMessageDescriptor(node)) {
    return path.length ? [{ path, message: node }] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child, index) =>
      child == null ? [] : flattenFormErrors(child, [...path, index]),
    );
  }
  if (typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) =>
      flattenFormErrors(value, [...path, key]),
    );
  }
  return [];
};

const humanizeFieldName = (segment: string): string =>
  segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

export const describeErrorLocation = (
  path: Array<string | number>,
  model: string,
): string => {
  const parts: string[] = [];
  path.forEach((segment, index) => {
    if (typeof segment === 'number') {
      parts[parts.length - 1] = `${parts[parts.length - 1] ?? ''} #${segment + 1}`;
      return;
    }
    parts.push(
      index === 0
        ? SECTION_LABEL_BY_MODEL[model]?.[segment] ?? humanizeFieldName(segment)
        : humanizeFieldName(segment),
    );
  });
  return parts.join(' › ');
};

const IMAGE_RULE_BY_PATH = new Map(
  HOMEPAGE_IMAGE_RULES.map((rule) => [rule.path.replace('[]', ''), rule]),
);

export const imageHintFor = (path: Array<string | number>): string | null => {
  const key = path.filter((segment) => typeof segment === 'string').join('.');
  const rule = IMAGE_RULE_BY_PATH.get(key);
  return rule
    ? `Upload the ${rule.label} — exactly ${rule.width}×${rule.height} px.`
    : null;
};
