import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { TELEGRAM_PAGE_UID, TELEGRAM_SLUG_PATTERN } from '../../../constants/telegram';

// The Join Telegram page is a standalone singleton (same model as the
// Subscription Page): its URL is the `slug` on the single type and it is
// public only while `enabled`. No entity owns it and no page template is
// involved.

export type TelegramRouteState = {
  documentId?: string;
  slug?: string;
  enabled?: boolean;
  updatedAt?: string;
  seo?: { noIndex?: boolean };
};

export async function readTelegramRoute(
  strapi: Core.Strapi,
  locale = DEFAULT_CONTENT_LOCALE,
): Promise<TelegramRouteState | null> {
  return strapi.documents(TELEGRAM_PAGE_UID as any).findFirst({
    locale,
    fields: ['documentId', 'slug', 'enabled', 'updatedAt'] as any,
    populate: { seo: { fields: ['noIndex'] } } as any,
  }) as Promise<TelegramRouteState | null>;
}

export function telegramPath(row: TelegramRouteState | null | undefined): string | null {
  return row?.slug && TELEGRAM_SLUG_PATTERN.test(row.slug) ? `/${row.slug}/` : null;
}

/** Route-inventory membership: only an enabled page with a valid slug. */
export async function telegramRouteMetadata(strapi: Core.Strapi, locale: string) {
  const row = await readTelegramRoute(strapi, locale);
  const path = telegramPath(row);
  return row?.enabled === true && path
    ? [{ path, updatedAt: row.updatedAt, noIndex: row.seo?.noIndex === true, pageType: 'telegram' as const }]
    : [];
}
