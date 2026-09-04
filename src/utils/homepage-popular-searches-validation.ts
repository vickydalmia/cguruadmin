import type { Core } from '@strapi/strapi';
import {
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { toValidationError } from './write-validation/problems';

const HOMEPAGE_UID = 'api::homepage.homepage';
const RELATION_FIELDS = ['stores', 'brands', 'categories', 'banks'] as const;

type PopularSearchRelationField = (typeof RELATION_FIELDS)[number];

function relations(
  value: unknown,
  field: PopularSearchRelationField,
): RelationEntry[] {
  if (!value || typeof value !== 'object') return [];
  const selected = Reflect.get(value, field);
  return Array.isArray(selected) ? selected : [];
}

export async function validateHomepagePopularSearches(
  strapi: Core.Strapi,
  data: unknown,
  documentId?: string,
  locale?: string,
): Promise<void> {
  if (
    !data ||
    typeof data !== 'object' ||
    !Object.prototype.hasOwnProperty.call(data, 'popularSearches')
  ) {
    return;
  }

  const section = Reflect.get(data, 'popularSearches');
  if (!section || typeof section !== 'object') return;
  // The schema default is ON. Treat an omitted value as enabled so a newly
  // added empty component cannot slip through before defaults are persisted.
  if (Reflect.get(section, 'enabled') === false) return;

  const current: any = documentId
    ? await strapi.documents(HOMEPAGE_UID).findOne({
      documentId,
      ...(locale ? { locale } : {}),
        fields: ['documentId'],
        populate: {
          popularSearches: {
            populate: Object.fromEntries(
              RELATION_FIELDS.map((field) => [
                field,
                { fields: ['documentId'] },
              ]),
            ),
          },
        } as any,
      })
    : null;
  const storedSection = current?.popularSearches;

  const selectionCount = RELATION_FIELDS.reduce((total, field) => {
    const stored = relations(storedSection, field);
    if (!Object.prototype.hasOwnProperty.call(section, field)) {
      return total + stored.length;
    }
    const selected =
      resultingRelations(Reflect.get(section, field), stored) ?? stored;
    return total + selected.length;
  }, 0);

  if (selectionCount > 0) return;

  throw toValidationError([
    {
      path: ['popularSearches', 'stores'],
      message:
        'Popular Searches is enabled. Select at least one Store, Brand, Category, or Bank, or switch the section off.',
    },
  ]);
}
