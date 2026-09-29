import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import { TELEGRAM_PAGE_CAPS, TELEGRAM_PAGE_UID, TELEGRAM_SLUG_PATTERN } from '../constants/telegram';
import { resultingRelationCount } from './deal-of-the-day-validation';
import { toValidationError, type Problem } from './write-validation/problems';

/**
 * Store logos in the "favourite stores" bubble cloud have exactly twelve
 * design slots; more would overflow the layout. Repeatable component caps
 * (preview cards, feature cards, features) are enforced by the schema `max`.
 */
const hasText = (value: unknown) => typeof value === 'string' && Boolean(value.trim());

export async function validateTelegramPage(
  strapi: Core.Strapi,
  data: any,
  locale?: string,
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const problems: Problem[] = [];

  // Pin the stored-state read to the locale being written: the single type
  // holds one row per content locale (same reasoning as Independence Day).
  const current = await strapi.db.query(TELEGRAM_PAGE_UID).findOne({
    where: { locale: locale ?? DEFAULT_CONTENT_LOCALE },
    populate: { hero: true, favouriteStores: { populate: ['stores'] } } as any,
  });
  const shared = !current && locale && locale !== DEFAULT_CONTENT_LOCALE
    ? await strapi.db.query(TELEGRAM_PAGE_UID).findOne({ where: { locale: DEFAULT_CONTENT_LOCALE }, select: ['enabled', 'slug'] })
    : null;
  const merged = { ...shared, ...current, ...data };

  if ('slug' in data && !TELEGRAM_SLUG_PATTERN.test(String(data.slug ?? ''))) {
    problems.push({ path: ['slug'], message: 'Use a single lowercase URL segment containing letters, digits and hyphens.' });
  }
  const hero = data.hero && typeof data.hero === 'object' ? { ...current?.hero, ...data.hero } : data.hero === null ? null : current?.hero;
  if (merged.enabled === true && !hasText(hero?.titleLead)) {
    problems.push({ path: ['hero'], message: 'Add the hero headline before enabling this page.' });
  }

  const incoming = data.favouriteStores?.stores;
  if (incoming !== undefined) {
    const count = resultingRelationCount(incoming, current?.favouriteStores?.stores ?? []);
    const max = TELEGRAM_PAGE_CAPS.favouriteStores;
    if (count != null && count > max) {
      problems.push({
        path: ['favouriteStores', 'stores'],
        message: `Favourite stores accepts at most ${max} Stores. Remove ${count - max}.`,
      });
    }
  }
  if (problems.length) throw toValidationError(problems);
}
