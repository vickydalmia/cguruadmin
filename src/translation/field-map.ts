// Translation FIELD MAP: the schema-driven walker that decides, for one
// localized document, WHAT gets translated, what gets copied, and how the
// target-locale write payload is assembled.
//
// Source of truth is the schema itself: an attribute participates iff the
// content type marked it `pluginOptions.i18n.localized` (Phase 1 flags).
// Inside a localized component EVERYTHING belongs to the locale version:
// human-readable text is translated, URLs/ids/codes are copied verbatim
// (COPY_ONLY_SUBFIELDS), media is re-attached by file id (the file itself is
// shared), and relations are re-connected by documentId — the documents API
// resolves those to the TARGET locale's rows (verified in @strapi/core
// transform/relations/utils/i18n.js: source localized + target localized →
// relation connects at the written document's locale, and throws when that
// locale version is missing — which is why buildLocalizedData pre-filters
// relations through an existence map and reports what it had to skip).
import type { Core } from '@strapi/strapi';
import { TranslationError } from './errors';

/** Dot-joined path of a translatable value inside one entry. */
export type LeafPath = string;

export type TranslatableLeaf = {
  path: LeafPath;
  kind: 'plain' | 'richtext';
  /** Hard schema budget for the TRANSLATED value, when the field has one. */
  maxLength?: number;
  value: string;
};

/**
 * Subfield names inside localized components that match the text-type rule
 * but must never reach the LLM: URLs, anchors, machine ids, codes, and
 * numeric display values. Exact names, checked at every nesting depth.
 */
const COPY_ONLY_SUBFIELDS = new Set([
  'url',
  'ctaUrl',
  'primaryUrl',
  'secondaryUrl',
  'buttonUrl',
  'link',
  'linkOverride',
  'preSaleCtaHref',
  'liveCtaHref',
  'canonicalUrl',
  'targetId',
  'anchorId',
  'categoryId',
  'code',
  'value',
  'year',
  'number',
]);

const TEXT_TYPES = new Set(['string', 'text', 'richtext']);

const INTERNAL_FIELDS = new Set([
  'id',
  'documentId',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
  'locale',
  'localizations',
  '__temp_key__',
]);

type AnySchema = { attributes?: Record<string, any> };

function componentSchema(strapi: Core.Strapi, uid: string): AnySchema {
  return (strapi.getModel(uid as any) as AnySchema) ?? { attributes: {} };
}

function isLocalizedAttribute(definition: any): boolean {
  return definition?.pluginOptions?.i18n?.localized === true;
}

function isOwnerSideRelation(definition: any): boolean {
  // mappedBy marks the inverse side; writing the owner side is what creates
  // the join rows, and the inverse reads them back for free.
  return definition?.type === 'relation' && !definition.mappedBy;
}

function leafKind(definition: any): 'plain' | 'richtext' {
  return definition?.type === 'richtext' ? 'richtext' : 'plain';
}

function leafBudget(definition: any): number | undefined {
  const max = Number(definition?.maxLength);
  return Number.isFinite(max) && max > 0 ? Math.floor(max * 0.95) : undefined;
}

export type RelationTarget = { targetUid: string; documentIds: string[] };

export type RelationExistence = {
  /**
   * `${targetUid}:${documentId}` for every relation target that exists in
   * the locale being written (or whose target type is not localized).
   */
  present: ReadonlySet<string>;
};

export type LocalizedWritePlan = {
  /** The payload for documents().update({ locale, data }). */
  data: Record<string, unknown>;
  /** Relation targets dropped because their locale version is missing. */
  skippedRelations: Array<{ path: LeafPath; targetUid: string; documentId: string }>;
};

/**
 * Every localized attribute of `uid`, walked depth-first over the POPULATED
 * entry, yielding the translatable text leaves in stable path order. The
 * same walk (buildLocalizedData below) consumes the translated map, so the
 * two can never disagree about what a path means.
 */
export function collectTranslatableLeaves(
  strapi: Core.Strapi,
  uid: string,
  entry: any,
): TranslatableLeaf[] {
  const model = strapi.getModel(uid as any) as AnySchema;
  const leaves: TranslatableLeaf[] = [];

  const walkText = (
    schema: AnySchema,
    value: any,
    prefix: string,
    insideComponent: boolean,
  ) => {
    for (const [key, definition] of Object.entries(schema.attributes ?? {})) {
      if (INTERNAL_FIELDS.has(key)) continue;
      if (!insideComponent && !isLocalizedAttribute(definition)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const fieldValue = value?.[key];

      if (TEXT_TYPES.has(definition.type)) {
        if (insideComponent && COPY_ONLY_SUBFIELDS.has(key)) continue;
        if (typeof fieldValue === 'string' && fieldValue.trim()) {
          leaves.push({
            path,
            kind: leafKind(definition),
            maxLength: leafBudget(definition),
            value: fieldValue,
          });
        }
        continue;
      }
      if (definition.type === 'component') {
        const child = componentSchema(strapi, definition.component);
        if (definition.repeatable && Array.isArray(fieldValue)) {
          fieldValue.forEach((item, index) =>
            walkText(child, item, `${path}.${index}`, true),
          );
        } else if (fieldValue && typeof fieldValue === 'object') {
          walkText(child, fieldValue, path, true);
        }
        continue;
      }
      if (definition.type === 'dynamiczone' && Array.isArray(fieldValue)) {
        fieldValue.forEach((item, index) => {
          if (item?.__component) {
            walkText(
              componentSchema(strapi, item.__component),
              item,
              `${path}.${index}`,
              true,
            );
          }
        });
      }
      // relations, media, scalars: nothing to translate.
    }
  };

  walkText(model, entry, '', false);
  return leaves;
}

/**
 * Every relation target referenced from the localized attributes, grouped by
 * target uid — the input for the batched locale-existence check.
 */
export function collectRelationTargets(
  strapi: Core.Strapi,
  uid: string,
  entry: any,
): RelationTarget[] {
  const model = strapi.getModel(uid as any) as AnySchema;
  const byUid = new Map<string, Set<string>>();

  const walk = (
    schema: AnySchema,
    value: any,
    insideComponent: boolean,
  ) => {
    for (const [key, definition] of Object.entries(schema.attributes ?? {})) {
      if (INTERNAL_FIELDS.has(key)) continue;
      if (!insideComponent && !isLocalizedAttribute(definition)) {
        // Top level: only localized attributes are written… except
        // relations, which are force-localized without carrying the flag.
        if (!isOwnerSideRelation(definition)) continue;
      }
      const fieldValue = value?.[key];
      if (definition.type === 'relation') {
        if (!isOwnerSideRelation(definition) || !definition.target) continue;
        const items = Array.isArray(fieldValue)
          ? fieldValue
          : fieldValue
            ? [fieldValue]
            : [];
        for (const item of items) {
          const documentId = item?.documentId;
          if (typeof documentId !== 'string' || !documentId) continue;
          const set = byUid.get(definition.target) ?? new Set<string>();
          set.add(documentId);
          byUid.set(definition.target, set);
        }
        continue;
      }
      if (definition.type === 'component') {
        const child = componentSchema(strapi, definition.component);
        if (definition.repeatable && Array.isArray(fieldValue)) {
          for (const item of fieldValue) walk(child, item, true);
        } else if (fieldValue && typeof fieldValue === 'object') {
          walk(child, fieldValue, true);
        }
        continue;
      }
      if (definition.type === 'dynamiczone' && Array.isArray(fieldValue)) {
        for (const item of fieldValue) {
          if (item?.__component) {
            walk(componentSchema(strapi, item.__component), item, true);
          }
        }
      }
    }
  };

  walk(model, entry, false);
  return [...byUid.entries()].map(([targetUid, documentIds]) => ({
    targetUid,
    documentIds: [...documentIds],
  }));
}

/**
 * Batched existence check: which relation targets have a row in
 * `targetLocale`? Targets of NON-localized types are always present — the
 * single shared row is what the relation connects to.
 */
export async function resolveRelationExistence(
  strapi: Core.Strapi,
  targets: RelationTarget[],
  targetLocale: string,
): Promise<RelationExistence> {
  const present = new Set<string>();
  await Promise.all(
    targets.map(async ({ targetUid, documentIds }) => {
      const model = strapi.getModel(targetUid as any) as any;
      const localized =
        model?.pluginOptions?.i18n?.localized === true;
      if (!localized) {
        for (const documentId of documentIds) {
          present.add(`${targetUid}:${documentId}`);
        }
        return;
      }
      const rows: any[] = await strapi.db.query(targetUid as any).findMany({
        where: { documentId: { $in: documentIds }, locale: targetLocale },
        select: ['documentId'],
      } as any);
      for (const row of rows ?? []) {
        if (row?.documentId) present.add(`${targetUid}:${row.documentId}`);
      }
    }),
  );
  return { present };
}

/**
 * Assemble the target-locale write payload from the populated source entry:
 * translated text where the map has the path, copied scalars/URLs, media by
 * file id, relations as ordered `set` connects filtered through the
 * existence map. Component `id`s are stripped at every level so Strapi
 * creates the locale's own component rows instead of stealing the source's.
 */
export function buildLocalizedData(
  strapi: Core.Strapi,
  uid: string,
  entry: any,
  translations: ReadonlyMap<LeafPath, string>,
  existence: RelationExistence,
): LocalizedWritePlan {
  const model = strapi.getModel(uid as any) as AnySchema;
  const skippedRelations: LocalizedWritePlan['skippedRelations'] = [];

  const mediaValue = (definition: any, value: any) => {
    if (definition.multiple) {
      const items = Array.isArray(value) ? value : [];
      return items.map((item) => item?.id).filter((id) => id != null);
    }
    return value?.id ?? null;
  };

  const relationValue = (definition: any, value: any, path: string) => {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    const connect: Array<{ documentId: string }> = [];
    for (const item of items) {
      const documentId = item?.documentId;
      if (typeof documentId !== 'string' || !documentId) continue;
      if (existence.present.has(`${definition.target}:${documentId}`)) {
        connect.push({ documentId });
      } else {
        skippedRelations.push({ path, targetUid: definition.target, documentId });
      }
    }
    // `set` replaces the stored relation wholesale in array order, so the
    // locale twin mirrors the source ordering (top picks, ordered coupons).
    return { set: connect };
  };

  const buildObject = (
    schema: AnySchema,
    value: any,
    prefix: string,
    insideComponent: boolean,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, definition] of Object.entries(schema.attributes ?? {})) {
      if (INTERNAL_FIELDS.has(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const fieldValue = value?.[key];

      if (!insideComponent) {
        const write =
          isLocalizedAttribute(definition) || isOwnerSideRelation(definition);
        if (!write) continue;
      }

      if (TEXT_TYPES.has(definition.type)) {
        const mustTranslate =
          !(insideComponent && COPY_ONLY_SUBFIELDS.has(key)) &&
          typeof fieldValue === 'string' &&
          fieldValue.trim().length > 0;
        if (mustTranslate && !translations.has(path)) {
          throw new TranslationError('TRANSLATION_QUALITY_GATE_FAILED', {
            detail: `validated translation is missing path ${path}`,
          });
        }
        out[key] = mustTranslate
          ? translations.get(path)
          : (fieldValue ?? null);
        continue;
      }
      if (definition.type === 'component') {
        const child = componentSchema(strapi, definition.component);
        if (definition.repeatable) {
          const items = Array.isArray(fieldValue) ? fieldValue : [];
          out[key] = items.map((item, index) =>
            buildObject(child, item, `${path}.${index}`, true),
          );
        } else {
          out[key] =
            fieldValue && typeof fieldValue === 'object'
              ? buildObject(child, fieldValue, path, true)
              : null;
        }
        continue;
      }
      if (definition.type === 'dynamiczone') {
        const items = Array.isArray(fieldValue) ? fieldValue : [];
        out[key] = items.map((item, index) =>
          item?.__component
            ? {
                __component: item.__component,
                ...buildObject(
                  componentSchema(strapi, item.__component),
                  item,
                  `${path}.${index}`,
                  true,
                ),
              }
            : item,
        );
        continue;
      }
      if (definition.type === 'media') {
        out[key] = mediaValue(definition, fieldValue);
        continue;
      }
      if (definition.type === 'relation') {
        if (!definition.target || definition.relation?.toLowerCase?.().includes('morph')) {
          continue;
        }
        out[key] = relationValue(definition, fieldValue, path);
        continue;
      }
      // Scalars, enums, dates, json, booleans: the locale version keeps the
      // source's value. (Top-level non-localized scalars never reach here —
      // Strapi itself syncs those.)
      out[key] = fieldValue === undefined ? null : fieldValue;
    }
    return out;
  };

  return {
    data: buildObject(model, entry, '', false),
    skippedRelations,
  };
}
