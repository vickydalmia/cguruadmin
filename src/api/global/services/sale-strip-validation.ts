import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';
import { GLOBAL_UID } from './integrations';

export function validateSaleStrip(strip: any): void {
  if (!strip?.enabled && !strip?.homepageEnabled) return;
  const problems: Problem[] = [];
  for (const field of ['logoAlt', 'heading', 'highlight', 'description', 'brandsValue', 'brandsLabel', 'couponsValue', 'couponsLabel', 'discountValue', 'discountLabel', 'ctaLabel', 'ctaUrl']) {
    if (typeof strip[field] !== 'string' || !strip[field].trim()) {
      problems.push({ path: ['saleStrip', field], message: 'Required when the sale strip is enabled.' });
    }
  }
  if (typeof strip.ctaUrl === 'string' && strip.ctaUrl.trim()) {
    const value = strip.ctaUrl.trim();
    let safe = false;
    if (!/[\s\\]/.test(value)) {
      if (value.startsWith('/') && !value.startsWith('//')) safe = true;
      else {
        try {
          const url = new URL(value);
          safe = /^https?:\/\//i.test(value) && !url.username && !url.password;
        } catch { /* Report the field below. */ }
      }
    }
    if (!safe) problems.push({ path: ['saleStrip', 'ctaUrl'], message: 'Use a site path starting with / or a complete HTTP(S) URL, without spaces or credentials.' });
  }
  if (problems.length) throw toValidationError(problems);
}

export async function validateSaleStripForWrite(
  strapi: Core.Strapi, data: any, documentId?: string, locale = DEFAULT_CONTENT_LOCALE,
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(data ?? {}, 'saleStrip') || data.saleStrip == null) return;
  const stored = documentId ? await strapi.documents(GLOBAL_UID).findOne({
    documentId, locale, populate: { saleStrip: true },
  } as any) as any : null;
  validateSaleStrip({ ...stored?.saleStrip, ...data.saleStrip });
}
