// Translation WRITER: the one primitive that persists a locale version.
// Deliberately goes through strapi.documents().update — NOT raw SQL — so
// the full document middleware chain runs on machine output exactly as it
// does on an editor's: richtext sanitization, (lenient) validation, and the
// ISR outbox event that revalidates the localized paths. The locale upsert
// semantics are core's (repository.js: update with a locale that has no row
// CREATES it, copying non-localized fields).
import { isDeepStrictEqual } from 'node:util';
import type { Core } from '@strapi/strapi';
import {
  buildLocalizedData,
  collectTranslatableLeaves,
  collectRelationReferences,
  resolveRelationDependencies,
  type RelationDependency,
  type LocalizedWritePlan,
} from './field-map';
import { runWithTranslationWriteContext } from './write-flag';
import { sanitizeRichtextData } from '../utils/sanitize-richtext';
import { normaliseTextFields } from '../utils/text-field-validation';

/**
 * The write pipeline's mutators (richtext allowlist, trim/collapse) change
 * the plan before it is persisted, so translation memory — the raw provider
 * output — must be normalised the same way before it is compared with the
 * stored row. Otherwise a translation with a trailing space is "not current"
 * forever: rewritten and re-invalidated on every sweep.
 */
function normalisedPlanData(uid: string, data: Record<string, unknown>) {
  const clone = structuredClone(data);
  sanitizeRichtextData(uid, clone);
  normaliseTextFields(uid, 'update', clone);
  return clone;
}

export class TranslationDependencyBlockedError extends Error {
  readonly dependencies: RelationDependency[];

  constructor(dependencies: RelationDependency[]) {
    super(
      `${dependencies.length} required relation target(s) missing before localized write`,
    );
    this.name = 'TranslationDependencyBlockedError';
    this.dependencies = dependencies;
  }
}

/**
 * Deeply-populated source entry — everything the walker needs: components
 * (nested), media ids, relation documentIds. Built with the content-manager
 * populate-builder like i18n's own fill-from-locale service.
 */
export async function loadPopulatedEntry(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
  locale: string,
): Promise<any | null> {
  // The populate-builder service is itself a factory function; the Service
  // type erases that, hence the cast (same shape i18n's fill-from-locale
  // uses it with).
  const populateBuilder = strapi
    .plugin('content-manager')
    .service('populate-builder') as unknown as (uid: string) => {
    populateDeep(depth: number): { build(): Promise<any> };
  };
  const populate = await populateBuilder(uid).populateDeep(Infinity).build();
  return strapi.documents(uid as any).findOne({
    documentId,
    locale,
    populate,
  } as any);
}

export async function writeLocaleVersion(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
  targetLocale: string,
  sourceEntry: any,
  translations: ReadonlyMap<string, string>,
): Promise<{
  skippedRelations: LocalizedWritePlan['skippedRelations'];
  missingDependencies: RelationDependency[];
  created: boolean;
}> {
  const relations = await resolveRelationDependencies(
    strapi,
    uid,
    sourceEntry,
    targetLocale,
  );
  // Resolve again at the writer boundary so a relation removed between the
  // dispatcher's preflight and publication cannot create a partial locale row.
  if (relations.required.length > 0) {
    throw new TranslationDependencyBlockedError(relations.required);
  }
  const plan = buildLocalizedData(
    strapi,
    uid,
    sourceEntry,
    translations,
    relations.existence,
  );
  const existing = await loadPopulatedEntry(
    strapi,
    uid,
    documentId,
    targetLocale,
  );
  await runWithTranslationWriteContext({
    sourceEntry,
    targetLocale,
    plan,
    targetRowExisted: Boolean(existing),
    operation: 'upsert',
  }, () =>
    strapi.documents(uid as any).update({
      documentId,
      locale: targetLocale,
      data: plan.data as any,
    } as any),
  );
  return {
    skippedRelations: plan.skippedRelations,
    missingDependencies: relations.missing,
    created: !existing,
  };
}

export type LocaleVersionInspection = {
  /** True only when the persisted locale row already matches the full write plan. */
  current: boolean;
  /** Relations absent from the target locale and therefore omitted from the plan. */
  skippedRelations: LocalizedWritePlan['skippedRelations'];
};

/**
 * Determine whether a locale write would change anything, without running the
 * documents update pipeline (and therefore without emitting an ISR event).
 *
 * Comparing translation_state hashes alone is insufficient: relations and
 * component structure are intentionally outside the paid-text hash. Build the
 * exact desired write plan, normalize the populated target row through the
 * same schema walker, then compare those two payload shapes. This preserves
 * the nightly relation-repair guarantee while making a truly current backfill
 * a database/ISR no-op.
 */
export async function inspectLocaleVersion(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
  targetLocale: string,
  sourceEntry: any,
  translations: ReadonlyMap<string, string>,
): Promise<LocaleVersionInspection> {
  const relations = await resolveRelationDependencies(
    strapi,
    uid,
    sourceEntry,
    targetLocale,
  );
  const desired = buildLocalizedData(
    strapi,
    uid,
    sourceEntry,
    translations,
    relations.existence,
  );
  const targetEntry = await loadPopulatedEntry(
    strapi,
    uid,
    documentId,
    targetLocale,
  );
  if (!targetEntry) {
    return { current: false, skippedRelations: desired.skippedRelations };
  }

  const targetTranslations = new Map(
    collectTranslatableLeaves(strapi, uid, targetEntry).map((leaf) => [
      leaf.path,
      leaf.value,
    ]),
  );
  const targetExistence = {
    // The target entry is already deeply populated. Every relation visible on
    // it necessarily exists, so derive the keys locally instead of issuing a
    // second batch of existence queries during every repair inspection.
    present: new Set(
      collectRelationReferences(strapi, uid, targetEntry).map(
        ({ targetUid, documentId: targetDocumentId }) =>
          `${targetUid}:${targetDocumentId}`,
      ),
    ),
  };
  const persisted = buildLocalizedData(
    strapi,
    uid,
    targetEntry,
    targetTranslations,
    targetExistence,
  );

  return {
    current: isDeepStrictEqual(
      normalisedPlanData(uid, desired.data),
      normalisedPlanData(uid, persisted.data),
    ),
    skippedRelations: desired.skippedRelations,
  };
}

/** Remove a generated locale when its English source document is deleted. */
export async function deleteLocaleVersion(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
  targetLocale: string,
): Promise<void> {
  const existing = await loadPopulatedEntry(
    strapi,
    uid,
    documentId,
    targetLocale,
  );
  if (!existing) return;
  await runWithTranslationWriteContext({
    sourceEntry: null,
    targetLocale,
    plan: null,
    targetRowExisted: true,
    operation: 'delete',
  }, () =>
    strapi.documents(uid as any).delete({
      documentId,
      locale: targetLocale,
    } as any),
  );
}
