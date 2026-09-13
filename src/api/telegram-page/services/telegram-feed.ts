import type { Core } from '@strapi/strapi';
import {
  TELEGRAM_CONFIG_DEFAULTS,
  TELEGRAM_CONFIG_LIMITS,
  TELEGRAM_CONFIG_UID,
  TELEGRAM_POST_UID,
} from '../../../constants/telegram';
import { sanitizeOutput, STORE_FIELDS } from '../../../utils/offer-visibility';
import { readTelegramIngestState } from '../../../telegram/state';
import { domainOf } from '../../../telegram/parse-post';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { requestedOfferTargetLocale } from '../../coupon/services/public-offer-ids';

// The public shape of one ingested channel post. Posts are NOT Deal or Coupon
// records: no documentId-based redeem link, no promo code, no offer tracking.
export type PublicTelegramPost = {
  id: string;
  messageId: number;
  postedAt: string;
  editedAt: string | null;
  title: string | null;
  text: string | null;
  salePrice: number | null;
  mrp: number | null;
  discountLabel: string | null;
  ctaUrl: string | null;
  permalink: string | null;
  photo: unknown | null;
  store: { name: string; slug: string; logo: unknown | null; logoAlt: string | null } | null;
};

export type TelegramFeed = {
  posts: PublicTelegramPost[];
  memberCount: number | null;
};

async function feedSettings(strapi: Core.Strapi) {
  const row: any = await strapi.documents(TELEGRAM_CONFIG_UID as any).findFirst({
    fields: ['feedPostCount', 'channel'] as any,
  });
  const value = row?.feedPostCount;
  const { min, max } = TELEGRAM_CONFIG_LIMITS.feedPostCount;
  const limit = Number.isInteger(value) && value >= min && value <= max
    ? value
    : TELEGRAM_CONFIG_DEFAULTS.feedPostCount;
  return { limit, channel: typeof row?.channel === 'string' ? row.channel.toLowerCase() : null };
}

/** Stores whose website hostname equals one of the post link domains. */
async function storesByDomain(
  strapi: Core.Strapi,
  domains: readonly string[],
  locale: string,
): Promise<Map<string, PublicTelegramPost['store']>> {
  const matches = new Map<string, PublicTelegramPost['store']>();
  const unique = [...new Set(domains)];
  if (!unique.length) return matches;
  // One bounded lookup for the whole feed, rather than a sequential query per post.
  const candidates: any[] = await strapi.documents('api::store.store' as any).findMany({
    locale,
    filters: { $or: unique.map(domain => ({ websiteUrl: { $containsi: domain } })) } as any,
    fields: [...STORE_FIELDS, 'websiteUrl'] as any,
    populate: { logo: true } as any,
    limit: unique.length * 5,
  });
  for (const store of candidates) {
    const domain = domainOf(store?.websiteUrl);
    if (domain && unique.includes(domain) && store?.name && store?.slug && !matches.has(domain)) {
      matches.set(domain, { name: store.name, slug: store.slug, logo: store.logo ?? null, logoAlt: store.logoAlt ?? null });
    }
  }
  return matches;
}

const numberOrNull = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

export async function buildTelegramFeed(strapi: Core.Strapi, ctx: any): Promise<TelegramFeed> {
  const [settings, state] = await Promise.all([feedSettings(strapi), readTelegramIngestState(strapi)]);
  const { limit, channel } = settings;
  const matchingState = channel && state.channel === channel;
  const chatId = channel?.startsWith('-100') ? channel : matchingState ? state.chatId : null;
  // A changed channel must never publish cached posts or counts from its predecessor.
  // Pre-upgrade state has no chatId. Its stored public permalink still proves
  // which channel a post belongs to, without waiting for another channel post.
  const channelFilter = chatId ? { chatId } : channel?.startsWith('@')
    ? { permalink: { $startsWithi: `https://t.me/${channel.slice(1)}/` } }
    : null;
  if (!channelFilter) return { posts: [], memberCount: matchingState ? state.memberCount : null };
  const rows: any[] = await strapi.documents(TELEGRAM_POST_UID as any).findMany({
    filters: { hidden: false, ...channelFilter } as any,
    sort: ['postedAt:desc', 'messageId:desc'] as any,
    limit,
    populate: { photo: true } as any,
  });
  const sanitized: any[] = await Promise.all(
    rows.map((row) => sanitizeOutput(strapi, ctx, TELEGRAM_POST_UID, row)),
  );
  const stores = await storesByDomain(
    strapi,
    sanitized.map((row) => row.storeDomain).filter((domain): domain is string => typeof domain === 'string' && domain.length > 0),
    requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE,
  );
  const posts = sanitized.map((row): PublicTelegramPost => ({
    id: row.documentId,
    messageId: Number(row.messageId),
    postedAt: row.postedAt,
    editedAt: row.editedAt ?? null,
    title: row.title ?? null,
    text: row.text ?? null,
    salePrice: numberOrNull(row.salePrice),
    mrp: numberOrNull(row.mrp),
    discountLabel: row.discountLabel ?? null,
    ctaUrl: row.ctaUrl ?? null,
    permalink: row.permalink ?? null,
    photo: row.photo ?? null,
    store: row.storeDomain ? stores.get(row.storeDomain) ?? null : null,
  }));
  return { posts, memberCount: matchingState ? state.memberCount : null };
}
