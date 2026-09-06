import type { Core } from '@strapi/strapi';

import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import { HOMEPAGE_UID } from '../constants/homepage-sections';
import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { homepageHeroEntityType } from './homepage-hero-offer';
import { toValidationError, type Problem } from './write-validation/problems';

type ComponentRow = Record<string, unknown>;

const rows = (value: unknown): ComponentRow[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is ComponentRow =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];

const componentId = (row: ComponentRow): string | null => {
  const id = row.id;
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
};

const storedRowFor = (
  incoming: ComponentRow,
  storedRows: ComponentRow[],
): ComponentRow | null => {
  const id = componentId(incoming);
  return id === null
    ? null
    : storedRows.find((stored) => componentId(stored) === id) ?? null;
};

const storedRelation = (value: unknown): RelationEntry[] => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is RelationEntry => relationKeys(entry).length > 0);
  }
  return relationKeys(value).length > 0 ? [value as RelationEntry] : [];
};

const resultingRelation = (
  incoming: unknown,
  stored: unknown,
): RelationEntry | null => {
  if (incoming === undefined) return storedRelation(stored)[0] ?? null;
  const result = resultingRelations(incoming, storedRelation(stored));
  if (result !== null) return result[0] ?? null;
  return relationKeys(incoming).length > 0
    ? (incoming as RelationEntry)
    : null;
};

/** Every Product/Offer row selects exactly one schema matching entityType. */
export async function validateHomepageHeroOffers(
  strapi: Core.Strapi,
  data: unknown,
  locale?: string,
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const hero = Reflect.get(data, 'hero');
  if (!hero || typeof hero !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(hero, 'products')) return;

  const incomingRows = rows(Reflect.get(hero, 'products'));
  if (incomingRows.length === 0) return;
  // Pinned to the locale being written: the homepage holds one row per
  // content locale, and the stored rows resolve partial hero payloads.
  const current: any = await strapi.db.query(HOMEPAGE_UID).findOne({
    where: { locale: locale ?? DEFAULT_CONTENT_LOCALE },
    populate: {
      hero: {
        populate: {
          products: { populate: ['deal', 'coupon'] },
        },
      },
    } as any,
  });
  const storedRows = rows(current?.hero?.products);
  const problems: Problem[] = [];

  incomingRows.forEach((incoming, index) => {
    const stored = storedRowFor(incoming, storedRows);
    const deal = resultingRelation(incoming.deal, stored?.deal);
    const coupon = resultingRelation(incoming.coupon, stored?.coupon);
    const entityType = homepageHeroEntityType({
      entityType:
        Object.prototype.hasOwnProperty.call(incoming, 'entityType')
          ? incoming.entityType
          : stored?.entityType,
      deal,
      coupon,
    });
    const path = ['hero', 'products', index] as const;

    if (!entityType) {
      problems.push({
        path: [...path, 'entityType'],
        message: 'Choose whether this Product/Offer is a Product Deal or Coupon.',
      });
      return;
    }

    if (entityType === 'deal') {
      if (!deal) {
        problems.push({
          path: [...path, 'deal'],
          message: 'Select a Product Deal for this Product/Offer.',
        });
      }
      if (coupon) {
        problems.push({
          path: [...path, 'coupon'],
          message: 'A Product/Offer set to Product Deal cannot also select a Coupon.',
        });
      }
      return;
    }

    if (!coupon) {
      problems.push({
        path: [...path, 'coupon'],
        message: 'Select a Coupon for this Product/Offer.',
      });
    }
    if (deal) {
      problems.push({
        path: [...path, 'deal'],
        message: 'A Product/Offer set to Coupon cannot also select a Product Deal.',
      });
    }
  });

  if (problems.length > 0) throw toValidationError(problems);
}
