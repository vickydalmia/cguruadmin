// Directory INVENTORY & RANKING: item mapping, alias resolution, offer
// ownership counts, popularity ordering and public media shaping. Split
// out of the directory service (see ./directory.ts).
import type { Core } from '@strapi/strapi';
import { normaliseImageBackgroundColour } from '../../../constants/image-background';
import type { DirectoryKind } from './directory';
import type { EntityConfig } from './directory-queries';

export const POPULAR_LIMIT = 8;

type DirectoryItem = {
  documentId: string;
  name: string;
  slug: string;
  media: ReturnType<typeof publicMedia>;
  mediaAlt: string;
};

export type EntityInventory = {
  couponKeys: Set<string>;
  productDealKeys: Set<string>;
  latestPublication: number;
};

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized || null;
}

function documentKey(document: any): string | null {
  const documentId = cleanText(document?.documentId);
  if (documentId) return `document:${documentId}`;
  if (document?.id != null) return `id:${String(document.id)}`;
  const slug = cleanText(document?.slug);
  return slug ? `slug:${slug}` : null;
}

function offerKey(offer: any): string | null {
  const documentId = cleanText(offer?.documentId);
  if (documentId) return documentId;
  return offer?.id != null ? `id:${String(offer.id)}` : null;
}

function publicationTime(offer: any): number {
  // Same precedence as the query sort above: editor-controlled `publishedOn`
  // first, Strapi's `publishedAt` only as a fallback for unbackfilled rows.
  const value =
    cleanText(offer?.publishedOn) ??
    cleanText(offer?.publishedAt) ??
    cleanText(offer?.updatedAt);
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base' });
}

export function mapDirectoryItems(
  documents: any[],
  config: EntityConfig,
): DirectoryItem[] {
  const byDocumentId = new Map<string, DirectoryItem>();

  for (const document of documents) {
    const documentId = cleanText(document?.documentId);
    const name = cleanText(document?.name);
    const slug = cleanText(document?.slug);
    if (!documentId || !name || !slug || byDocumentId.has(documentId)) continue;
    const media = publicMedia(document?.[config.mediaField], false);
    const mediaAlt =
      cleanText(document?.[config.mediaAltField]) ??
      cleanText(media?.alternativeText) ??
      name;
    byDocumentId.set(documentId, {
      documentId,
      name,
      slug,
      media,
      mediaAlt,
    });
  }

  return [...byDocumentId.values()].sort((left, right) => {
    const byName = compareNames(left.name, right.name);
    return byName || left.documentId.localeCompare(right.documentId);
  });
}

export function createEntityAliases(items: DirectoryItem[]): Map<string, DirectoryItem> {
  const aliases = new Map<string, DirectoryItem>();
  for (const item of items) {
    aliases.set(`document:${item.documentId}`, item);
    aliases.set(`slug:${item.slug}`, item);
  }
  return aliases;
}

function resolveEntity(
  relation: any,
  aliases: Map<string, DirectoryItem>,
): DirectoryItem | null {
  const key = documentKey(relation);
  if (key && aliases.has(key)) return aliases.get(key)!;
  const slug = cleanText(relation?.slug);
  return slug ? (aliases.get(`slug:${slug}`) ?? null) : null;
}

function distinctOfferOwners(
  offer: any,
  kind: DirectoryKind,
  config: EntityConfig,
  aliases: Map<string, DirectoryItem>,
): DirectoryItem[] {
  const relations = Array.isArray(offer?.[config.relationField])
    ? [...offer[config.relationField]]
    : [];

  const owners = new Map<string, DirectoryItem>();
  for (const relation of relations) {
    const entity = resolveEntity(relation, aliases);
    if (entity) owners.set(entity.documentId, entity);
  }
  return [...owners.values()];
}

export function collectInventory(
  offers: any[],
  entityType: 'coupon' | 'productDeal',
  kind: DirectoryKind,
  config: EntityConfig,
  aliases: Map<string, DirectoryItem>,
  inventory: Map<string, EntityInventory>,
): Set<string> {
  const directoryOfferKeys = new Set<string>();

  for (const offer of offers) {
    const key = offerKey(offer);
    if (!key) continue;
    const owners = distinctOfferOwners(offer, kind, config, aliases);
    if (owners.length === 0) continue;

    directoryOfferKeys.add(key);
    const timestamp = publicationTime(offer);
    for (const owner of owners) {
      const entry = inventory.get(owner.documentId)!;
      if (entityType === 'coupon') entry.couponKeys.add(key);
      else entry.productDealKeys.add(key);
      entry.latestPublication = Math.max(entry.latestPublication, timestamp);
    }
  }

  return directoryOfferKeys;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicMedia(media: any, includeFormats = true) {
  const url = cleanText(media?.url);
  if (!url) return null;

  const formats: Record<string, any> = {};
  for (const [name, rawFormat] of Object.entries(
    includeFormats ? (media?.formats ?? {}) : {},
  )) {
    const format = rawFormat as any;
    const formatUrl = cleanText(format?.url);
    if (!formatUrl) continue;
    formats[name] = {
      url: formatUrl,
      width: numberOrNull(format?.width),
      height: numberOrNull(format?.height),
      mime: cleanText(format?.mime),
      ext: cleanText(format?.ext),
    };
  }

  return {
    url,
    backgroundColour: normaliseImageBackgroundColour(media?.backgroundColour),
    alternativeText: cleanText(media?.alternativeText),
    width: numberOrNull(media?.width),
    height: numberOrNull(media?.height),
    mime: cleanText(media?.mime),
    ext: cleanText(media?.ext),
    formats: Object.keys(formats).length > 0 ? formats : null,
  };
}

export function comparePopular(
  left: DirectoryItem,
  right: DirectoryItem,
  inventory: Map<string, EntityInventory>,
): number {
  const leftInventory = inventory.get(left.documentId)!;
  const rightInventory = inventory.get(right.documentId)!;
  const leftCount = leftInventory.couponKeys.size + leftInventory.productDealKeys.size;
  const rightCount = rightInventory.couponKeys.size + rightInventory.productDealKeys.size;
  const byCount = rightCount - leftCount;
  if (byCount) return byCount;

  const byLatest = rightInventory.latestPublication - leftInventory.latestPublication;
  if (byLatest) return byLatest;

  const byName = compareNames(left.name, right.name);
  return byName || left.documentId.localeCompare(right.documentId);
}

export async function hydratePopular(
  strapi: Core.Strapi,
  config: EntityConfig,
  selected: DirectoryItem[],
  inventory: Map<string, EntityInventory>,
) {
  if (selected.length === 0) return [];

  const fields = ['name', 'slug', config.mediaAltField];
  const documents = (await strapi.documents(config.uid as any).findMany({
    filters: { documentId: { $in: selected.map((item) => item.documentId) } },
    fields,
    populate: { [config.mediaField]: true },
    limit: selected.length,
  } as any)) as any[];
  const hydratedById = new Map<string, any>();
  for (const document of documents) {
    const documentId = cleanText(document?.documentId);
    if (documentId) hydratedById.set(documentId, document);
  }

  return selected.map((item) => {
    const hydrated = hydratedById.get(item.documentId);
    const media = publicMedia(hydrated?.[config.mediaField]);
    const mediaAlt =
      cleanText(hydrated?.[config.mediaAltField]) ??
      cleanText(media?.alternativeText) ??
      item.name;
    const counts = inventory.get(item.documentId)!;

    return {
      ...item,
      media,
      mediaAlt,
      couponCount: counts.couponKeys.size,
      productDealCount: counts.productDealKeys.size,
    };
  });
}
