import type { Core } from '@strapi/strapi';

import {
  HOMEPAGE_POPULAR_REGULAR_LIMIT,
  HOMEPAGE_POPULAR_TOTAL_LIMIT,
  HOMEPAGE_UID,
} from '../constants/homepage-sections';
import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { toValidationError } from './write-validation/problems';

const REGULAR_RELATION_FIELDS = ['stores', 'brands'] as const;
type RegularRelationField = (typeof REGULAR_RELATION_FIELDS)[number];

const storedRelations = (value: unknown): RelationEntry[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is RelationEntry => relationKeys(entry).length > 0)
    : [];

function resultingCount(
  section: Record<string, unknown>,
  storedSection: Record<string, unknown> | null,
  field: RegularRelationField,
): number {
  const stored = storedRelations(storedSection?.[field]);
  if (!Object.prototype.hasOwnProperty.call(section, field)) return stored.length;
  return (resultingRelations(section[field], stored) ?? stored).length;
}

/**
 * Popular Stores & Brands renders one featured card plus at most 30 regular
 * cards. Strapi can constrain either relation independently, but only this
 * combined check can reject 20 Stores + 11 Brands before the save commits.
 */
export async function validateHomepagePopularStores(
  strapi: Core.Strapi,
  data: unknown,
  documentId?: string,
  locale?: string,
): Promise<void> {
  if (
    !data ||
    typeof data !== 'object' ||
    !Object.prototype.hasOwnProperty.call(data, 'popularStores')
  ) {
    return;
  }

  const section = Reflect.get(data, 'popularStores');
  if (!section || typeof section !== 'object' || Array.isArray(section)) return;

  const current: any = documentId
    ? await strapi.documents(HOMEPAGE_UID).findOne({
      documentId,
      ...(locale ? { locale } : {}),
        fields: ['documentId'],
        populate: {
          popularStores: {
            populate: Object.fromEntries(
              REGULAR_RELATION_FIELDS.map((field) => [
                field,
                { fields: ['documentId'] },
              ]),
            ),
          },
        } as any,
      })
    : null;

  const selected = section as Record<string, unknown>;
  const storedSection = current?.popularStores ?? null;
  const count = REGULAR_RELATION_FIELDS.reduce(
    (total, field) => total + resultingCount(selected, storedSection, field),
    0,
  );
  if (count <= HOMEPAGE_POPULAR_REGULAR_LIMIT) return;

  const excess = count - HOMEPAGE_POPULAR_REGULAR_LIMIT;
  throw toValidationError([
    {
      path: ['popularStores', 'stores'],
      message:
        `Popular Stores & Brands accepts at most ${HOMEPAGE_POPULAR_REGULAR_LIMIT} ` +
        `regular selections across Stores and Brands, plus 1 featured Store or Brand ` +
        `(${HOMEPAGE_POPULAR_TOTAL_LIMIT} cards total). You selected ${count}; remove ${excess} ` +
        `selection${excess === 1 ? '' : 's'}.`,
    },
  ]);
}
