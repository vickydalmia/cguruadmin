import type { Core } from '@strapi/strapi';
import { TranslationError } from './errors';
import { enabledContentLocaleCodesSync } from './locales/registry';
import type { TranslationWriteContext } from './write-flag';

/** Lock the English row until the localized write commits, closing the final-read race. */
export async function fenceTranslationPublication(
  strapi: Core.Strapi, trx: any, uid: string, documentId: string | undefined,
  context: TranslationWriteContext | null,
): Promise<void> {
  if (!context?.sourceEntry || context.operation !== 'upsert' || !documentId) return;
  if (!enabledContentLocaleCodesSync().includes(context.targetLocale)) {
    throw new TranslationError('TRANSLATION_UNAVAILABLE', { detail: 'target language is disabled' });
  }
  const table = strapi.db.metadata.get(uid).tableName;
  let query = trx(table).where({ document_id: documentId, locale: 'en' });
  if (context.sourceEntry.id) query = query.andWhere({ id: context.sourceEntry.id });
  if (['pg', 'postgres', 'postgresql'].includes(trx.client.config.client)) query = query.forUpdate();
  const rows = await query.select('updated_at');
  const expected = new Date(context.sourceEntry.updatedAt).getTime();
  if (!rows.some((row: any) => new Date(row.updated_at).getTime() === expected)) {
    throw new TranslationError('TRANSLATION_UNAVAILABLE', { detail: 'English source changed before publication' });
  }
  await context.assertPublicationLease?.(trx);
}
