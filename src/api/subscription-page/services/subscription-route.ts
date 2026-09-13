import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';

export const SUBSCRIPTION_PAGE_UID = 'api::subscription-page.subscription-page' as const;
export const SUBSCRIPTION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SubscriptionRouteState = {
  documentId?: string;
  slug?: string;
  enabled?: boolean;
  updatedAt?: string;
  seo?: { noIndex?: boolean };
};

export async function readSubscriptionRoute(
  strapi: Core.Strapi,
  locale = DEFAULT_CONTENT_LOCALE,
): Promise<SubscriptionRouteState | null> {
  return strapi.documents(SUBSCRIPTION_PAGE_UID as any).findFirst({
    locale,
    fields: ['documentId', 'slug', 'enabled', 'updatedAt'] as any,
    populate: { seo: { fields: ['noIndex'] } } as any,
  }) as Promise<SubscriptionRouteState | null>;
}

export function subscriptionPath(row: SubscriptionRouteState | null): string | null {
  return row?.slug && SUBSCRIPTION_SLUG_PATTERN.test(row.slug) ? `/${row.slug}/` : null;
}

export async function subscriptionRouteMetadata(strapi: Core.Strapi, locale: string) {
  const row = await readSubscriptionRoute(strapi, locale);
  const path = subscriptionPath(row);
  return row?.enabled === true && path
    ? [{ path, updatedAt: row.updatedAt, noIndex: row.seo?.noIndex === true, pageType: 'subscription' as const }]
    : [];
}
