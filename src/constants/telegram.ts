import type { SectionLabel } from './homepage-sections';

// Join Telegram campaign page. Three content types cooperate:
// - api::telegram.telegram (single type, Super Admin only): channel/bot
//   connection used by the ingest cron. Never localized — one channel per
//   country deployment, each of which has its own admin database.
// - api::telegram-post.telegram-post (collection): channel posts the cron
//   ingested. Editors may hide a post or correct its parsed fields.
// - api::telegram-page.telegram-page (single type, localized): the page copy
//   plus its own `slug` and `enabled` switch — a standalone page like the
//   Subscription Page, not an entity-owned campaign template.

export const TELEGRAM_CONFIG_UID = 'api::telegram.telegram' as const;
export const TELEGRAM_POST_UID = 'api::telegram-post.telegram-post' as const;
export const TELEGRAM_PAGE_UID = 'api::telegram-page.telegram-page' as const;
/** Single lowercase URL segment; the page lives at `/${slug}/`. */
export const TELEGRAM_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TELEGRAM_DEFAULT_SLUG = 'join-telegram';

/** Media Library folder that receives re-hosted channel photos. */
export const TELEGRAM_MEDIA_FOLDER_NAME = 'Telegram Posts';

/** Core-store slot for the ingest runtime state (offset, heartbeat, member count). */
export const TELEGRAM_INGEST_STORE = { type: 'plugin', name: 'telegram-ingest' } as const;
export const TELEGRAM_INGEST_STATE_KEY = 'state';

export const TELEGRAM_CONFIG_DEFAULTS = {
  pollIntervalMinutes: 5,
  maxStoredPosts: 60,
  feedPostCount: 6,
} as const;

export const TELEGRAM_CONFIG_LIMITS = {
  pollIntervalMinutes: { min: 1, max: 60 },
  maxStoredPosts: { min: 10, max: 200 },
  feedPostCount: { min: 1, max: 12 },
} as const;

export const TELEGRAM_PAGE_CAPS = {
  previewCards: 3,
  floatingCards: 3,
  features: 6,
  favouriteStores: 12,
} as const;

/** Largest channel photo the ingest will re-host; bigger sizes are skipped. */
export const TELEGRAM_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** getChatMemberCount is cheap but not free; refresh at most this often. */
export const TELEGRAM_MEMBER_COUNT_REFRESH_MS = 30 * 60_000;
/** Pages of 100 updates drained per poll; bounds one cron tick. */
export const TELEGRAM_MAX_UPDATE_PAGES = 10;

export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
/** `@username` (public channel) or `-100…` numeric id (any channel). */
export const TELEGRAM_CHANNEL_PATTERN = /^(?:@[A-Za-z][A-Za-z0-9_]{3,31}|-100\d{6,})$/;
export const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export const TELEGRAM_SETTINGS_LABELS: SectionLabel[] = [
  { attr: 'title', label: 'Admin title', description: 'Internal name shown in the admin only.' },
  {
    attr: 'enabled',
    label: 'Ingest channel posts',
    description:
      'Turn on to let the server poll the channel for new posts. The bot below must be an Administrator of the channel; only posts made after the bot joined are received.',
  },
  {
    attr: 'botToken',
    label: 'Bot token',
    description:
      'Token from @BotFather (digits:letters). Stored privately, never sent to the website. Required while ingestion is enabled.',
  },
  {
    attr: 'channel',
    label: 'Channel',
    description:
      'Public channel as @username, or the numeric -100… chat id for a private channel. Required while ingestion is enabled.',
  },
  {
    attr: 'channelUsername',
    label: 'Channel username (optional)',
    description:
      'Only needed when Channel is a numeric id but the channel is public: the username builds the "open post" links. Leave empty otherwise.',
  },
  {
    attr: 'pollIntervalMinutes',
    label: 'Poll interval (minutes)',
    description: `How often the server asks Telegram for new posts (${TELEGRAM_CONFIG_LIMITS.pollIntervalMinutes.min}–${TELEGRAM_CONFIG_LIMITS.pollIntervalMinutes.max}).`,
  },
  {
    attr: 'maxStoredPosts',
    label: 'Posts to keep',
    description: `Older posts (and their photos) are deleted beyond this count (${TELEGRAM_CONFIG_LIMITS.maxStoredPosts.min}–${TELEGRAM_CONFIG_LIMITS.maxStoredPosts.max}).`,
  },
  {
    attr: 'feedPostCount',
    label: 'Posts shown on the page',
    description: `Newest visible posts rendered in "Latest deals from our Telegram channel" (${TELEGRAM_CONFIG_LIMITS.feedPostCount.min}–${TELEGRAM_CONFIG_LIMITS.feedPostCount.max}).`,
  },
];

export const TELEGRAM_PAGE_SECTION_LABELS: SectionLabel[] = [
  {
    attr: 'title',
    label: 'Admin title',
    description: 'Internal name shown in the admin only. Every section below was pre-filled from the design on first boot; edit any field or switch a section off — later deployments never overwrite your changes.',
  },
  {
    attr: 'enabled',
    label: 'Page enabled',
    description: 'Turn on to publish the page at its URL. While off the URL returns 404 and the page leaves the sitemap; redirects from a previous slug are retired.',
  },
  {
    attr: 'slug',
    label: 'Page URL slug',
    description: 'One lowercase segment, e.g. join-telegram → /join-telegram/. Must not collide with a Store, Brand, Category, Bank, product-deal page, redirect or the Subscription Page. Renaming leaves a permanent redirect from the old URL.',
  },
  {
    attr: 'hero',
    label: '1 · Hero',
    description:
      'Headline (lead / accent word / tail), subtitle, the big Join button label, the members line and up to 3 preview chat cards. The Join button always opens Global Settings › Telegram URL.',
  },
  {
    attr: 'benefits',
    label: '2 · What you get inside',
    description:
      'Phone mockup image, up to 3 floating feature cards, up to 6 bullet features and the trust badge.',
  },
  {
    attr: 'latestDeals',
    label: '3 · Latest deals from the channel',
    description:
      'Heading, preview note and outlined CTA. The cards come from ingested channel posts (Telegram Posts); the count is set in the Telegram settings.',
  },
  {
    attr: 'favouriteStores',
    label: '4 · Favourite stores',
    description: `Up to ${TELEGRAM_PAGE_CAPS.favouriteStores} Stores whose logos float in the bubble cloud, plus the "more stores" line and CTA.`,
  },
  {
    attr: 'faq',
    label: '5 · FAQ',
    description: 'Accordion of questions and answers.',
  },
  {
    attr: 'joinCta',
    label: '6 · Join banner',
    description: 'Gradient band near the footer with heading, description and CTA label.',
  },
  {
    attr: 'popularSearches',
    label: '7 · Popular Searches',
    description: 'Existing Store, Brand, Category and Bank relations rendered near the footer.',
  },
  {
    attr: 'seo',
    label: 'SEO (search & social)',
    description: 'Meta title, description and share image for this page.',
  },
];
