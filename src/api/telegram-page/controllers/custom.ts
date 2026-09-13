import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { TELEGRAM_PAGE_UID } from '../../../constants/telegram';
import { sanitizeOutput } from '../../../utils/offer-visibility';
import { requestedOfferTargetLocale } from '../../coupon/services/public-offer-ids';
import { buildTelegramFeed } from '../services/telegram-feed';
import { telegramPath } from '../services/telegram-route';
import { TELEGRAM_PAGE_POPULATE } from './telegram-page-populate';

// Aggregate endpoint for the Join Telegram landing page: the localized page
// copy (with its slug) plus the newest visible ingested channel posts and
// the cached member count, in one request. `data: null` while disabled.

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async telegramPageFull(ctx: any) {
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const page = await strapi
      .documents(TELEGRAM_PAGE_UID as any)
      .findFirst({ locale, populate: TELEGRAM_PAGE_POPULATE as any });

    // Disabled or slug-less: nothing public (route inventory also omits it).
    if ((page as any)?.enabled !== true || !telegramPath(page as any)) return ctx.send({ data: null });

    const sanitized = await sanitizeOutput(strapi, ctx, TELEGRAM_PAGE_UID, page);
    const feed = await buildTelegramFeed(strapi, ctx);

    return ctx.send({
      data: { ...sanitized, latestPosts: feed.posts, memberCount: feed.memberCount },
    });
  },
});
