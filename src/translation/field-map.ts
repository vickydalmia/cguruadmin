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
import { heroOfferIdentityName } from './hero-offer-identity';
import { manualFooterEntityName } from './manual-footer-entity-names';

/** Dot-joined path of a translatable value inside one entry. */
export type LeafPath = string;

export type TranslatableLeaf = {
  path: LeafPath;
  kind: 'plain' | 'richtext';
  /** Prompt target, slightly below the schema ceiling when one exists. */
  maxLength?: number;
  /** Actual schema ceiling; omitted for dictionary limits, where maxLength is hard. */
  validationMaxLength?: number;
  value: string;
  /**
   * Optional guidance shown to the LLM under "## Field notes" (e.g. which
   * plural form a UI-dictionary row is). Never set by the schema walker and
   * deliberately excluded from sourceContentHash — it is prompt context, not
   * source content.
   */
  note?: string;
  /**
   * Actual taxonomy entity name that may legitimately remain in Latin script.
   * Still offered for translation; only the "must be translated" verdicts
   * are waived. Promotional headings never receive this flag.
   */
  identity?: boolean;
  /** Exact English name of a verified entity linked by a footer nav label. */
  linkedEntityName?: string;
  /** Official store/brand name on the homepage hero's selected offer. */
  linkedOfferName?: string;
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

const ENTITY_NAME_UIDS = new Set([
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
]);

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

function leafValidationBudget(definition: any): number | undefined {
  const max = Number(definition?.maxLength);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : undefined;
}

export type RelationTarget = { targetUid: string; documentIds: string[] };

export type RelationReference = {
  path: LeafPath;
  targetUid: string;
  documentId: string;
};

export type RelationDependency = RelationReference & {
  required: boolean;
};

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

const OPTIONAL_FORWARD_RELATION_UIDS = new Set([
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
]);

const OFFER_UIDS = new Set(['api::coupon.coupon', 'api::deal.deal']);
const OFFER_TAXONOMY_RELATIONS = new Set([
  'stores',
  'logoStore',
  'brands',
  'categories',
  'banks',
]);

/** Publication impact of a missing localized relation target. */
export function relationIsRequired(uid: string, path: string): boolean {
  if (OPTIONAL_FORWARD_RELATION_UIDS.has(uid)) return false;
  if (OFFER_UIDS.has(uid)) {
    return OFFER_TAXONOMY_RELATIONS.has(path.split('.')[0] ?? '');
  }
  // Homepage, menu, footer, global, CMS pages and jobs are structural: their
  // relation graph must be complete before the locale row becomes public.
  return true;
}

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
    schemaUid: string = uid,
  ) => {
    for (const [key, definition] of Object.entries(schema.attributes ?? {})) {
      if (INTERNAL_FIELDS.has(key)) continue;
      if (!insideComponent && !isLocalizedAttribute(definition)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const fieldValue = value?.[key];

      if (TEXT_TYPES.has(definition.type)) {
        if (insideComponent && COPY_ONLY_SUBFIELDS.has(key)) continue;
        if (typeof fieldValue === 'string' && fieldValue.trim()) {
          const linkedEntityName = uid === 'api::footer.footer'
            && schemaUid === 'nav.link' && key === 'label'
            && typeof value?.store?.documentId === 'string'
            && typeof value?.store?.name === 'string'
            && fieldValue.trim() === value.store.name.trim()
            ? value.store.name.trim()
            : uid === 'api::footer.footer' && schemaUid === 'nav.link' && key === 'label'
              ? manualFooterEntityName(value) : undefined;
          const linkedOfferName = uid === 'api::homepage.homepage'
            && schemaUid === 'home.hero-product' && key === 'titleOverride'
            ? heroOfferIdentityName(value, fieldValue) : undefined;
          leaves.push({
            path,
            kind: leafKind(definition),
            maxLength: leafBudget(definition),
            validationMaxLength: leafValidationBudget(definition),
            value: fieldValue,
            ...(linkedEntityName ? {
              linkedEntityName,
              note: 'This label is the linked entity’s official name; it may retain its original spelling.',
            } : {}),
            ...(linkedOfferName ? {
              linkedOfferName,
              note: 'This title is the linked offer’s official store or brand name; it may retain its original spelling.',
            } : {}),
            ...(path === 'name' && ENTITY_NAME_UIDS.has(uid)
              ? { identity: true }
              : {}),
          });
        }
        continue;
      }
      if (definition.type === 'component') {
        const child = componentSchema(strapi, definition.component);
        if (definition.repeatable && Array.isArray(fieldValue)) {
          fieldValue.forEach((item, index) =>
            walkText(child, item, `${path}.${index}`, true, definition.component),
          );
        } else if (fieldValue && typeof fieldValue === 'object') {
          walkText(child, fieldValue, path, true, definition.component);
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
              item.__component,
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
export function collectRelationReferences(
  strapi: Core.Strapi,
  uid: string,
  entry: any,
): RelationReference[] {
  const model = strapi.getModel(uid as any) as AnySchema;
  const references: RelationReference[] = [];

  const walk = (
    schema: AnySchema,
    value: any,
    prefix: string,
    insideComponent: boolean,
  ) => {
    for (const [key, definition] of Object.entries(schema.attributes ?? {})) {
      if (INTERNAL_FIELDS.has(key)) continue;
      if (!insideComponent && !isLocalizedAttribute(definition)) {
        // Top level: only localized attributes are written… except
        // relations, which are force-localized without carrying the flag.
        if (!isOwnerSideRelation(definition)) continue;
      }
      const path = prefix ? `${prefix}.${key}` : key;
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
          references.push({ path, targetUid: definition.target, documentId });
        }
        continue;
      }
      if (definition.type === 'component') {
        const child = componentSchema(strapi, definition.component);
        if (definition.repeatable && Array.isArray(fieldValue)) {
          for (const [index, item] of fieldValue.entries()) {
            walk(child, item, `${path}.${index}`, true);
          }
        } else if (fieldValue && typeof fieldValue === 'object') {
          walk(child, fieldValue, path, true);
        }
        continue;
      }
      if (definition.type === 'dynamiczone' && Array.isArray(fieldValue)) {
        for (const [index, item] of fieldValue.entries()) {
          if (item?.__component) {
            walk(
              componentSchema(strapi, item.__component),
              item,
              `${path}.${index}`,
              true,
            );
          }
        }
      }
    }
  };

  walk(model, entry, '', false);
  return references;
}

export function collectRelationTargets(
  strapi: Core.Strapi,
  uid: string,
  entry: any,
): RelationTarget[] {
  const byUid = new Map<string, Set<string>>();
  for (const { targetUid, documentId } of collectRelationReferences(
    strapi,
    uid,
    entry,
  )) {
    const set = byUid.get(targetUid) ?? new Set<string>();
    set.add(documentId);
    byUid.set(targetUid, set);
  }
  return [...byUid.entries()].map(([targetUid, documentIds]) => ({
    targetUid,
    documentIds: [...documentIds],
  }));
}

export async function resolveRelationDependencies(
  strapi: Core.Strapi,
  uid: string,
  entry: any,
  targetLocale: string,
): Promise<{
  existence: RelationExistence;
  missing: RelationDependency[];
  required: RelationDependency[];
  optional: RelationDependency[];
}> {
  const references = collectRelationReferences(strapi, uid, entry);
  const byUid = new Map<string, Set<string>>();
  for (const reference of references) {
    const set = byUid.get(reference.targetUid) ?? new Set<string>();
    set.add(reference.documentId);
    byUid.set(reference.targetUid, set);
  }
  const existence = await resolveRelationExistence(
    strapi,
    [...byUid.entries()].map(([targetUid, documentIds]) => ({
      targetUid,
      documentIds: [...documentIds],
    })),
    targetLocale,
  );
  const seen = new Set<string>();
  const missing = references.flatMap((reference) => {
    const key = `${reference.path}:${reference.targetUid}:${reference.documentId}`;
    if (
      seen.has(key) ||
      existence.present.has(`${reference.targetUid}:${reference.documentId}`)
    ) {
      return [];
    }
    seen.add(key);
    return [{ ...reference, required: relationIsRequired(uid, reference.path) }];
  });
  return {
    existence,
    missing,
    required: missing.filter((dependency) => dependency.required),
    optional: missing.filter((dependency) => !dependency.required),
  };
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
        if (!isOwnerSideRelation(definition) || !definition.target || definition.relation?.toLowerCase?.().includes('morph')) {
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
