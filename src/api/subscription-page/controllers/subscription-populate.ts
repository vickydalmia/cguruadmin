export const SUBSCRIPTION_POPULATE = {
  breadcrumbItems: true,
  hero: true,
  signup: { populate: { icon: true } },
  platforms: { populate: { cards: { populate: { icon: true } } } },
  benefits: { populate: { cards: { populate: { icon: true } } } },
  joinCta: true,
  popularSearches: { populate: {
    stores: { fields: ['name', 'slug'] },
    brands: { fields: ['name', 'slug'] },
    categories: { fields: ['name', 'slug'] },
    banks: { fields: ['name', 'slug'] },
  } },
  seo: { populate: { ogImage: true } },
} as const;
