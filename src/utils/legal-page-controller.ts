import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from './offer-visibility';
import { cleanHtml } from './sanitize-richtext';

export const LEGAL_PAGE_POPULATE = {
  breadcrumbItems: true,
  navigationItems: true,
  supportCta: true,
  sections: true,
  seo: {
    populate: {
      ogImage: true,
    },
  },
} as const;

function sanitizeSectionBodies(value: any): any {
  if (!Array.isArray(value?.sections)) return value;

  for (const section of value.sections) {
    if (typeof section?.body === 'string') {
      section.body = cleanHtml(section.body);
    }
  }

  return value;
}

export async function sendLegalPage(
  strapi: Core.Strapi,
  ctx: any,
  uid:
    | 'api::privacy-policy-page.privacy-policy-page'
    | 'api::terms-and-conditions-page.terms-and-conditions-page'
    | 'api::affiliate-disclosure-page.affiliate-disclosure-page',
) {
  const page = await strapi
    .documents(uid as any)
    .findFirst({ populate: LEGAL_PAGE_POPULATE as any });

  // Both public routes carry complete committed fallbacks, so the absence of
  // a saved single type is valid data and must not turn the page into a 404.
  if (!page) return ctx.send({ data: null });

  const sanitized = await sanitizeOutput(strapi, ctx, uid, page);
  return ctx.send({ data: sanitizeSectionBodies(sanitized) });
}
