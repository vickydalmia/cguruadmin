import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';

export const GLOBAL_UID = 'api::global.global';
export const INTEGRATION_FIELDS = ['telegramUrl', 'whatsappUrl', 'sendyUrl', 'sendyListId'] as const;

export function normalizeIntegrations(data: any): void {
  for (const field of INTEGRATION_FIELDS) {
    if (typeof data?.[field] === 'string') data[field] = data[field].trim() || null;
  }
}

export function validateIntegrations(data: any): void {
  const problems: Problem[] = [];
  for (const field of INTEGRATION_FIELDS) {
    const value = data?.[field];
    if (value == null || value === '') continue;
    const maxLength = field === 'sendyListId' ? 255 : 2048;
    if (typeof value !== 'string' || value.length > maxLength || /\s/.test(value)) {
      problems.push({ path: [field], message: `Use a value without spaces, up to ${maxLength} characters.` });
      continue;
    }
    if (field === 'sendyListId') continue;
    try {
      const url = new URL(value);
      if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      if (field === 'sendyUrl' && (url.protocol !== 'https:' || url.search || url.hash)) throw new Error();
    } catch {
      problems.push({ path: [field], message: field === 'sendyUrl'
        ? 'Enter the full HTTPS Sendy installation URL, without credentials, a query or a fragment.'
        : 'Enter a complete HTTP(S) URL without credentials.' });
    }
  }
  if (Boolean(data?.sendyUrl) !== Boolean(data?.sendyListId)) {
    problems.push({ path: [data?.sendyUrl ? 'sendyListId' : 'sendyUrl'], message: 'Set both Sendy URL and List ID, or clear both to disable subscriptions.' });
  }
  if (problems.length) throw toValidationError(problems);
}

export async function validateIntegrationsForWrite(
  strapi: Core.Strapi, data: any, documentId?: string, locale = DEFAULT_CONTENT_LOCALE,
): Promise<void> {
  if (!INTEGRATION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data ?? {}, field))) return;
  const stored = documentId ? await strapi.documents(GLOBAL_UID).findOne({
    documentId, locale, fields: [...INTEGRATION_FIELDS],
  } as any) : null;
  validateIntegrations({ ...stored, ...data });
}

export async function loadNewsletterConfig(strapi: Core.Strapi) {
  const global = await strapi.documents(GLOBAL_UID).findFirst({
    locale: DEFAULT_CONTENT_LOCALE,
    fields: ['sendyUrl', 'sendyListId'],
  } as any) as any;
  return { sendyUrl: global?.sendyUrl ?? '', sendyListId: global?.sendyListId ?? '' };
}
