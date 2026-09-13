import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';
import { SUBSCRIPTION_POPULATE } from '../controllers/subscription-populate';
import { readSubscriptionRoute, SUBSCRIPTION_PAGE_UID, SUBSCRIPTION_SLUG_PATTERN } from './subscription-route';

const hasText = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
export function validSubscriptionHref(value: unknown): boolean {
  if (!hasText(value)) return false;
  const href = String(value).trim();
  if (/[\s\\\u0000-\u001f]/u.test(href) || href.startsWith('//')) return false;
  if (/^\/(?!\/)/.test(href)) return true;
  try { const url = new URL(href); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

export function subscriptionContentProblems(page: any): Problem[] {
  const problems: Problem[] = [];
  if (!SUBSCRIPTION_SLUG_PATTERN.test(page?.slug ?? '')) {
    problems.push({ path: ['slug'], message: 'Use a single lowercase URL segment containing letters, digits and hyphens.' });
  }
  if (page?.enabled !== true) return problems;
  if (![page.hero?.headingBefore, page.hero?.headingHighlight, page.hero?.headingAfter, page.hero?.headingSecondLine].some(hasText)) {
    problems.push({ path: ['hero'], message: 'Add a page heading before enabling this page.' });
  }
  const required = (value: unknown, path: (string | number)[]) => {
    if (!hasText(value)) problems.push({ path, message: 'Enter text for this enabled section.' });
  };
  const link = (value: unknown, path: (string | number)[]) => {
    if (!validSubscriptionHref(value)) problems.push({ path, message: 'Enter a valid HTTPS URL or a path beginning with /.' });
  };
  if (page.signup && page.signup.enabled !== false) {
    for (const field of ['heading', 'emailLabel', 'emailPlaceholder', 'ctaLabel']) required(page.signup[field], ['signup', field]);
  }
  for (const key of ['platforms', 'benefits']) {
    const section = page[key];
    if (!section || section.enabled === false) continue;
    required(section.heading, [key, 'heading']);
    const seen = new Set<string>();
    for (const [index, card] of (section.cards ?? []).entries()) {
      if (card.enabled === false) continue;
      if (key === 'platforms') {
        if (!['telegram', 'youtube', 'instagram', 'facebook', 'reddit', 'x'].includes(card.platform) || seen.has(card.platform)) {
          problems.push({ path: [key, 'cards', index, 'platform'], message: 'Select a platform once per page.' });
        }
        seen.add(card.platform);
        for (const field of ['name', 'ctaLabel']) required(card[field], [key, 'cards', index, field]);
        link(card.ctaHref, [key, 'cards', index, 'ctaHref']);
      } else {
        required(card.label, [key, 'cards', index, 'label']);
        if (!card.icon && !card.iconKey) problems.push({ path: [key, 'cards', index, 'icon'], message: 'Upload an icon or select a standard icon.' });
      }
    }
  }
  if (page.joinCta && page.joinCta.enabled !== false) {
    required(page.joinCta.heading, ['joinCta', 'heading']);
    required(page.joinCta.ctaLabel, ['joinCta', 'ctaLabel']);
    link(page.joinCta.ctaHref, ['joinCta', 'ctaHref']);
  }
  return problems;
}

export async function validateSubscriptionContent(strapi: Core.Strapi, data: any, locale = DEFAULT_CONTENT_LOCALE) {
  const stored: any = await strapi.documents(SUBSCRIPTION_PAGE_UID as any).findFirst({ locale, populate: SUBSCRIPTION_POPULATE as any });
  // A first locale row inherits shared fields from English in Strapi. Judge
  // that effective state while keeping absent localized sections optional.
  const shared = locale !== DEFAULT_CONTENT_LOCALE ? await readSubscriptionRoute(strapi) : null;
  const page = { slug: shared?.slug ?? 'subscription', enabled: shared?.enabled ?? false, ...stored, ...data };
  // Omitted components retain their saved values; explicit null removes them.
  for (const key of ['hero', 'signup', 'platforms', 'benefits', 'joinCta']) {
    if (data?.[key] && typeof data[key] === 'object') page[key] = { ...stored?.[key], ...data[key] };
  }
  const problems = subscriptionContentProblems(page);
  if (problems.length) throw toValidationError(problems);
}
