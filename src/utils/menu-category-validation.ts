import type { Core } from '@strapi/strapi';

import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { toValidationError, type Problem } from './write-validation/problems';

export const MENU_UID = 'api::menu.menu';

function storedRelation(value: unknown): RelationEntry[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is RelationEntry =>
      relationKeys(entry).length > 0,
    );
  }
  return relationKeys(value).length > 0 ? [value as RelationEntry] : [];
}

function hasRelationAfterWrite(incoming: unknown, stored: unknown): boolean {
  if (incoming === undefined) return storedRelation(stored).length > 0;

  const result = resultingRelations(incoming, storedRelation(stored));
  if (result !== null) return result.length > 0;

  return relationKeys(incoming).length > 0;
}

function effectiveText(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
  field: string,
): string {
  const value = Object.prototype.hasOwnProperty.call(incoming, field)
    ? incoming[field]
    : stored?.[field];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A menu category group must always lead somewhere. Category-backed groups
 * inherit the Category icon; custom URL groups need their own uploaded icon.
 * The frontend still treats malformed legacy data defensively, but editor
 * saves fail inline instead of silently publishing a dead or iconless row.
 */
export async function validateMenuCategorySections(
  strapi: Core.Strapi,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (
    !data ||
    typeof data !== 'object' ||
    !Object.prototype.hasOwnProperty.call(data, 'categorySections')
  ) {
    return;
  }

  const sections = Reflect.get(data, 'categorySections');
  if (!Array.isArray(sections)) return;

  const current: any = documentId
    ? await strapi.documents(MENU_UID).findOne({
        documentId,
        fields: ['documentId'],
        populate: {
          categorySections: {
            populate: {
              category: { fields: ['documentId'] },
              icon: true,
            },
          },
        } as any,
      })
    : null;
  const storedById = new Map<number | string, Record<string, unknown>>();
  for (const section of current?.categorySections ?? []) {
    if (
      section &&
      typeof section === 'object' &&
      (typeof section.id === 'number' || typeof section.id === 'string')
    ) {
      storedById.set(section.id, section);
    }
  }

  const problems: Problem[] = [];
  sections.forEach((rawSection, index) => {
    if (!rawSection || typeof rawSection !== 'object') return;
    const section = rawSection as Record<string, unknown>;
    const stored =
      typeof section.id === 'number' || typeof section.id === 'string'
        ? storedById.get(section.id)
        : undefined;
    const hasCategory = hasRelationAfterWrite(
      section.category,
      stored?.category,
    );
    const url = effectiveText(section, stored, 'url');

    if (!hasCategory && !url) {
      problems.push({
        path: ['categorySections', index, 'category'],
        message:
          'Select a Category or enter a custom URL so this menu group has a destination.',
      });
    }

    if (
      !hasCategory &&
      !hasRelationAfterWrite(section.icon, stored?.icon)
    ) {
      problems.push({
        path: ['categorySections', index, 'icon'],
        message:
          'Upload an icon for a custom menu group. Category-backed groups can inherit the Category icon.',
      });
    }
  });

  if (problems.length > 0) throw toValidationError(problems);
}
