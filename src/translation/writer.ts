// Translation WRITER: the one primitive that persists a locale version.
// Deliberately goes through strapi.documents().update — NOT raw SQL — so
// the full document middleware chain runs on machine output exactly as it
// does on an editor's: richtext sanitization, (lenient) validation, and the
// ISR outbox event that revalidates the localized paths. The locale upsert
// semantics are core's (repository.js: update with a locale that has no row
// CREATES it, copying non-localized fields).
import type { Core } from '@strapi/strapi';
import {
  buildLocalizedData,
  collectRelationTargets,
  resolveRelationExistence,
  type LocalizedWritePlan,
} from './field-map';
import { runWithTranslationWriteFlag } from './write-flag';

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
): Promise<LocalizedWritePlan['skippedRelations']> {
  const targets = collectRelationTargets(strapi, uid, sourceEntry);
  const existence = await resolveRelationExistence(strapi, targets, targetLocale);
  const plan = buildLocalizedData(
    strapi,
    uid,
    sourceEntry,
    translations,
    existence,
  );
  await runWithTranslationWriteFlag(() =>
    strapi.documents(uid as any).update({
      documentId,
      locale: targetLocale,
      data: plan.data as any,
    } as any),
  );
  return plan.skippedRelations;
}

/** Remove a generated locale when its English source document is deleted. */
export async function deleteLocaleVersion(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
  targetLocale: string,
): Promise<void> {
  await runWithTranslationWriteFlag(() =>
    strapi.documents(uid as any).delete({
      documentId,
      locale: targetLocale,
    } as any),
  );
}
