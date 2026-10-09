import type { SectionLabel } from './homepage-sections';

export const GLOBAL_SETTINGS_LABELS: SectionLabel[] = [
  { attr: 'saleStrip', label: 'Sale strip — homepage and entities', description: 'Separate on/off and color controls for the homepage and all stores, brands, banks and categories. Shared logo, copy, three stats and destination. Homepage placement: between Top Offers and Top Deals. Entities: below Top Picks. Saving refreshes all pages. Copy is localized.' },
  { attr: 'telegramUrl', label: 'Telegram URL', description: 'Channel destination for banners and footer links, shared across all site languages. Leave empty for no active join link.' },
  { attr: 'telegramCta', label: 'Telegram banner', description: 'Banner visibility and translated text. The channel URL is managed above.' },
  { attr: 'whatsappUrl', label: 'WhatsApp URL', description: 'Channel destination for banners and footer links, shared across all site languages.' },
  { attr: 'sendyUrl', label: 'Sendy URL', description: 'HTTPS installation URL, for example https://newsletter.example.com/sendy. Set together with List ID; clear both to disable subscriptions. The API key stays on the server.' },
  { attr: 'sendyListId', label: 'Sendy List ID', description: 'Subscription list for this country site, shared across languages. This is the list ID, not the API key.' },
  { attr: 'newsletter', label: 'Newsletter text', description: 'Translated copy for the newsletter subscription form.' },
];
