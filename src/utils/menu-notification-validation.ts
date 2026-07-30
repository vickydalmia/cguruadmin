import type { Core } from '@strapi/strapi';

import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';
import { MENU_UID } from './menu-category-validation';
import { toValidationError, type Problem } from './write-validation/problems';

const MAX_OVERRIDE_IMAGE_PX = 80;
const NOTIFICATION_COMPONENTS = [
  {
    field: 'coupon',
    relation: 'coupon',
    label: 'Coupon',
  },
  {
    field: 'productDeal',
    relation: 'productDeal',
    label: 'Product Deal',
  },
] as const;

function storedRelation(value: unknown): RelationEntry[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is RelationEntry =>
      relationKeys(entry).length > 0,
    );
  }
  return relationKeys(value).length > 0 ? [value as RelationEntry] : [];
}

function resultingRelation(incoming: unknown, stored: unknown): RelationEntry | null {
  if (incoming === undefined) return storedRelation(stored)[0] ?? null;
  const result = resultingRelations(incoming, storedRelation(stored));
  if (result !== null) return result[0] ?? null;
  return relationKeys(incoming).length > 0
    ? (incoming as RelationEntry)
    : null;
}

function componentRows(value: unknown): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
}

function componentId(row: Record<string, unknown>): string | null {
  const id = row.id;
  return typeof id === 'number' || typeof id === 'string'
    ? String(id)
    : null;
}

function storedComponentRow(
  incoming: Record<string, unknown>,
  storedRows: Record<string, unknown>[],
): Record<string, unknown> | null {
  const incomingId = componentId(incoming);
  if (incomingId === null) return null;
  return (
    storedRows.find((stored) => componentId(stored) === incomingId) ?? null
  );
}

function effectiveField(
  incoming: Record<string, unknown> | null,
  stored: Record<string, unknown> | null,
  field: string,
): unknown {
  return incoming && Object.prototype.hasOwnProperty.call(incoming, field)
    ? incoming[field]
    : stored?.[field];
}

function relationEntries(value: unknown): RelationEntry[] {
  if (Array.isArray(value)) return value as RelationEntry[];
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.set)) return object.set as RelationEntry[];
  if (Array.isArray(object.connect)) return object.connect as RelationEntry[];
  return relationKeys(object).length > 0 ? [object] : [];
}

function mediaId(incoming: unknown, stored: unknown): number | null {
  const effective =
    incoming === undefined
      ? storedRelation(stored)
      : resultingRelations(incoming, storedRelation(stored)) ??
        relationEntries(incoming);
  const key = relationKeys(effective[0])[0];
  const id = Number(key);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Header Settings can publish any number of Coupon and Product Deal rows.
 * Each repeatable component owns its relation plus title/image overrides,
 * matching the Homepage component pattern.
 *
 * A component with override content must also select its related offer. Image
 * overrides are intentionally tiny because the public UI renders them as a
 * 44px circle: 80×80 px is the maximum accepted upload size.
 */
export async function validateMenuNotification(
  strapi: Core.Strapi,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const incoming = data as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(incoming, 'notification')) return;
  const incomingNotification =
    incoming.notification && typeof incoming.notification === 'object'
      ? (incoming.notification as Record<string, unknown>)
      : null;
  if (!incomingNotification) return;
  const touched = NOTIFICATION_COMPONENTS.filter(({ field }) =>
    Object.prototype.hasOwnProperty.call(incomingNotification, field),
  );
  if (touched.length === 0) return;

  const stored: any = documentId
    ? await strapi.documents(MENU_UID).findOne({
        documentId,
        fields: ['documentId'],
        populate: {
          notification: {
            populate: {
              coupon: {
                populate: {
                  coupon: { fields: ['documentId'] },
                  imageOverride: true,
                },
              },
              productDeal: {
                populate: {
                  productDeal: { fields: ['documentId'] },
                  imageOverride: true,
                },
              },
            },
          },
        } as any,
      })
    : null;
  const storedNotification =
    stored?.notification && typeof stored.notification === 'object'
      ? (stored.notification as Record<string, unknown>)
      : null;

  const problems: Problem[] = [];
  const imageChecks: Array<{
    field: string;
    fileId: number;
    path: (string | number)[];
    label: string;
  }> = [];

  for (const definition of touched) {
    const incomingRows = componentRows(
      incomingNotification[definition.field],
    );
    const storedRows = componentRows(
      storedNotification?.[definition.field],
    );

    for (const [index, incomingRow] of incomingRows.entries()) {
      const storedRow = storedComponentRow(incomingRow, storedRows);
      const relation = resultingRelation(
        incomingRow[definition.relation],
        storedRow?.[definition.relation],
      );
      const title = effectiveField(
        incomingRow,
        storedRow,
        'titleOverride',
      );
      const assignedImageId = mediaId(
        incomingRow.imageOverride,
        storedRow?.imageOverride,
      );
      const hasOverride =
        (typeof title === 'string' && title.trim().length > 0) ||
        assignedImageId !== null;

      if (!relation && hasOverride) {
        problems.push({
          path: [
            'notification',
            definition.field,
            index,
            definition.relation,
          ],
          message:
            `Select the ${definition.label} before adding notification overrides.`,
        });
      }
      if (assignedImageId !== null) {
        imageChecks.push({
          field: definition.field,
          fileId: assignedImageId,
          path: [
            'notification',
            definition.field,
            index,
            'imageOverride',
          ],
          label: definition.label,
        });
      }
    }
  }

  if (imageChecks.length > 0) {
    const ids = [...new Set(imageChecks.map((check) => check.fileId))];
    const files: any[] = await strapi.db.query('plugin::upload.file').findMany({
      where: { id: { $in: ids } },
      select: ['id', 'name', 'width', 'height'],
    });
    const byId = new Map(files.map((file) => [Number(file.id), file]));

    for (const check of imageChecks) {
      const file = byId.get(check.fileId);
      if (!file) continue;
      const width = Number(file.width);
      const height = Number(file.height);
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        width > MAX_OVERRIDE_IMAGE_PX ||
        height > MAX_OVERRIDE_IMAGE_PX
      ) {
        problems.push({
          path: check.path,
          message:
            `${check.label} notification image must be at most ` +
            `${MAX_OVERRIDE_IMAGE_PX}×${MAX_OVERRIDE_IMAGE_PX} px, but ` +
            `"${file.name}" is ${file.width ?? '?'}×${file.height ?? '?'} px.`,
        });
      }
    }
  }

  if (problems.length > 0) throw toValidationError(problems);
}
