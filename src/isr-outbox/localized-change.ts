import { isDeepStrictEqual } from 'node:util';
import type { Core } from '@strapi/strapi';

const IGNORED_WRITE_KEYS = new Set([
  'id',
  'documentId',
  'locale',
  'createdAt',
  'updatedAt',
  'publishedAt',
]);

export type SharedFieldSelection = {
  scalars: string[];
  media: string[];
  /** Unknown payload fields fail toward a cross-locale invalidation. */
  unknown: boolean;
};

/**
 * Non-localized scalar/media fields present in one localized update payload.
 * Relations are intentionally excluded: their locale graph is published by
 * the translation relation-sync after every required target row exists.
 */
export function sharedFieldSelection(
  model: any,
  data: unknown,
): SharedFieldSelection {
  const selection: SharedFieldSelection = {
    scalars: [],
    media: [],
    unknown: false,
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    selection.unknown = true;
    return selection;
  }
  const attributes = model?.attributes ?? {};
  for (const key of Object.keys(data)) {
    if (IGNORED_WRITE_KEYS.has(key)) continue;
    const attribute = attributes[key];
    if (!attribute) {
      selection.unknown = true;
      continue;
    }
    if (
      attribute.type === 'relation' ||
      attribute.pluginOptions?.i18n?.localized === true
    ) {
      continue;
    }
    if (attribute.type === 'media') selection.media.push(key);
    else selection.scalars.push(key);
  }
  return selection;
}

export function hasSharedFieldSelection(selection: SharedFieldSelection): boolean {
  return selection.scalars.length > 0 || selection.media.length > 0;
}

function mediaIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mediaIdentity);
  if (!value || typeof value !== 'object') return value ?? null;
  const documentId = Reflect.get(value, 'documentId');
  if (typeof documentId === 'string' && documentId) return documentId;
  const id = Reflect.get(value, 'id');
  return id ?? null;
}

export function sharedFieldSnapshot(
  row: any,
  selection: SharedFieldSelection,
): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null;
  return Object.fromEntries([
    ...selection.scalars.map((key) => [key, row[key] ?? null] as const),
    ...selection.media.map((key) => [key, mediaIdentity(row[key])] as const),
  ]);
}

export function sharedFieldSnapshotsDiffer(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): boolean {
  // A failed/missing snapshot is uncertainty, and uncertainty must invalidate
  // every locale rather than leave shared data stale.
  return !before || !after || !isDeepStrictEqual(before, after);
}

export async function loadSharedFieldSnapshot(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
  locale: string | undefined,
  selection: SharedFieldSelection,
): Promise<Record<string, unknown> | null> {
  const row = await strapi.documents(uid as any).findOne({
    documentId,
    ...(locale ? { locale } : {}),
    fields: ['documentId', ...selection.scalars] as any,
    ...(selection.media.length > 0
      ? {
          populate: Object.fromEntries(
            selection.media.map((key) => [
              key,
              { fields: ['documentId'] },
            ]),
          ) as any,
        }
      : {}),
  } as any);
  return sharedFieldSnapshot(row, selection);
}
