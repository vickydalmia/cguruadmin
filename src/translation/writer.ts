// Translation WRITER: the one primitive that persists a locale version.
// Deliberately goes through strapi.documents().update — NOT raw SQL — so
// the full document middleware chain runs on machine output exactly as it
// does on an editor's: richtext sanitization, (lenient) validation, and the
// ISR outbox event that revalidates the localized paths. The locale upsert
// semantics are core's (repository.js: update with a locale that has no row
// CREATES it, copying non-localized fields).
import { createHash } from 'node:crypto';
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
import { translationPopulate } from './populate';
import { verifyManualFooterStoreNames } from './manual-footer-store-names';

/**
 * The write pipeline's mutators (richtext allowlist, trim/collapse) change
 * the plan before it is persisted, so translation memory — the raw provider
 * output — must be normalised the same way before it is compared with the
 * stored row. Otherwise a translation with a trailing space is "not current"
 * forever: rewritten and re-invalidated on every sweep.
 */
export function normalisedPlanData(uid: string, data: Record<string, unknown>) {
  const clone = structuredClone(data);
  sanitizeRichtextData(uid, clone);
  normaliseTextFields(uid, 'update', clone);
  return clone;
}

export function localizedPlanHash(
  uid: string,
  data: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(normalisedPlanData(uid, data)))
    .digest('hex');
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
 * Translation-populated source entry — everything the walker needs, without
 * inverse mappedBy collections or Media Library folders. The schema-derived
 * plan is cached per Strapi process (see populate.ts).
 */
export async function loadPopulatedEntry(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
  locale: string,
): Promise<any | null> {
  const entry = await strapi.documents(uid as any).findOne({
    documentId,
    locale,
    populate: translationPopulate(strapi, uid),
  } as any);
  await verifyManualFooterStoreNames(strapi, uid, [entry], locale);
  return entry;
}

/** Bounded batch loader used by catalogue scans. */
export async function loadPopulatedEntries(
  strapi: Core.Strapi,
  uid: string,
  documentIds: readonly string[],
  locale: string,
): Promise<any[]> {
  if (documentIds.length === 0) return [];
  const entries = (await strapi.db.query(uid as any).findMany({
    where: {
      locale,
      documentId: { $in: [...documentIds] },
    },
    populate: translationPopulate(strapi, uid),
  } as any)) ?? [];
  await verifyManualFooterStoreNames(strapi, uid, entries, locale);
  return entries;
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
  planHash: string;
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
    planHash: localizedPlanHash(uid, plan.data),
  };
}

export type LocaleVersionInspection = {
  /** True only when the persisted locale row already matches the full write plan. */
  current: boolean;
  /** Relations absent from the target locale and therefore omitted from the plan. */
  skippedRelations: LocalizedWritePlan['skippedRelations'];
  /** Fingerprint persisted after a successful/current publication. */
  planHash: string;
};

export function inspectPopulatedLocaleVersion(
  strapi: Core.Strapi,
  uid: string,
  targetEntry: any | null,
  desired: LocalizedWritePlan,
): LocaleVersionInspection {
  const planHash = localizedPlanHash(uid, desired.data);
  if (!targetEntry) {
    return {
      current: false,
      skippedRelations: desired.skippedRelations,
      planHash,
    };
  }

  const targetTranslations = new Map(
    collectTranslatableLeaves(strapi, uid, targetEntry).map((leaf) => [
      leaf.path,
      leaf.value,
    ]),
  );
  const targetExistence = {
    // The target entry is already populated with the same bounded graph.
    // Every visible relation therefore exists in this locale.
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
    planHash,
  };
}

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
  return inspectPopulatedLocaleVersion(strapi, uid, targetEntry, desired);
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
