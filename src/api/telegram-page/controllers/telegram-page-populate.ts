// Telegram page POPULATE tree. Store logos ride the shared storeRef projection
// so the bubble cloud renders the same logo/alt pair every other surface uses.
import { storeRef } from '../../../utils/offer-visibility';

export const TELEGRAM_PAGE_POPULATE = {
  hero: { populate: { previewCards: { populate: { icon: true } } } },
  benefits: {
    populate: {
      phoneImage: true,
      floatingCards: { populate: { icon: true } },
      features: true,
    },
  },
  latestDeals: true,
  breadcrumbItems: true,
  newsletter: true,
  favouriteStores: { populate: { stores: storeRef } },
  faq: { populate: { items: true } },
  joinCta: true,
  popularSearches: {
    populate: {
      stores: { fields: ['name', 'slug'] },
      brands: { fields: ['name', 'slug'] },
      categories: { fields: ['name', 'slug'] },
      banks: { fields: ['name', 'slug'] },
    },
  },
  seo: { populate: { ogImage: true } },
} as const;
