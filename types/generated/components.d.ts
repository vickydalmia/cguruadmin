import type { Schema, Struct } from '@strapi/strapi';

export interface FooterCountry extends Struct.ComponentSchema {
  collectionName: 'components_footer_countries';
  info: {
    displayName: 'Country';
    icon: 'globe';
  };
  attributes: {
    code: Schema.Attribute.String & Schema.Attribute.Required;
    flag: Schema.Attribute.Media<'images'>;
    name: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface FooterLinkSection extends Struct.ComponentSchema {
  collectionName: 'components_footer_link_sections';
  info: {
    displayName: 'Footer Link Section';
    icon: 'folder';
  };
  attributes: {
    links: Schema.Attribute.Component<'nav.link', true>;
    title: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface FooterPartnerCard extends Struct.ComponentSchema {
  collectionName: 'components_footer_partner_cards';
  info: {
    displayName: 'Partner Card';
    icon: 'handHeart';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String;
    ctaUrl: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    title: Schema.Attribute.String;
  };
}

export interface FooterSocialLink extends Struct.ComponentSchema {
  collectionName: 'components_footer_social_links';
  info: {
    displayName: 'Social Link';
    icon: 'globe';
  };
  attributes: {
    platform: Schema.Attribute.Enumeration<
      [
        'facebook',
        'instagram',
        'pinterest',
        'linkedin',
        'telegram',
        'reddit',
        'twitter',
        'whatsapp',
        'youtube',
      ]
    > &
      Schema.Attribute.Required;
    url: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface HomeBankOfferItem extends Struct.ComponentSchema {
  collectionName: 'components_home_bank_offer_items';
  info: {
    displayName: 'Bank Offer Item';
    icon: 'landscape';
  };
  attributes: {
    bank: Schema.Attribute.Relation<'oneToOne', 'api::bank.bank'>;
    iconKind: Schema.Attribute.Enumeration<
      ['corporate', 'account', 'wallet', 'rupee']
    > &
      Schema.Attribute.DefaultTo<'corporate'>;
    subtitle: Schema.Attribute.String;
  };
}

export interface HomeBankOffers extends Struct.ComponentSchema {
  collectionName: 'components_home_bank_offers';
  info: {
    displayName: 'Bank Offers Section';
    icon: 'landscape';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    items: Schema.Attribute.Component<'home.bank-offer-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 6;
        },
        number
      >;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeCgExclusive extends Struct.ComponentSchema {
  collectionName: 'components_home_cg_exclusives';
  info: {
    displayName: 'CG Exclusive Section';
    icon: 'star';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    items: Schema.Attribute.Component<'home.exclusive-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeCouponCardItem extends Struct.ComponentSchema {
  collectionName: 'components_home_coupon_card_items';
  info: {
    displayName: 'Coupon Card Item';
    icon: 'ticket';
  };
  attributes: {
    cardImage: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    coupon: Schema.Attribute.Relation<'oneToOne', 'api::coupon.coupon'>;
    titleOverride: Schema.Attribute.String;
  };
}

export interface HomeDealList extends Struct.ComponentSchema {
  collectionName: 'components_home_deal_lists';
  info: {
    displayName: 'Deal List Section';
    icon: 'priceTag';
  };
  attributes: {
    deals: Schema.Attribute.Relation<'oneToMany', 'api::deal.deal'>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeExclusiveItem extends Struct.ComponentSchema {
  collectionName: 'components_home_exclusive_items';
  info: {
    displayName: 'CG Exclusive Item';
    icon: 'star';
  };
  attributes: {
    bannerOverride: Schema.Attribute.Media<'images'>;
    coupon: Schema.Attribute.Relation<'oneToOne', 'api::coupon.coupon'>;
    titleOverride: Schema.Attribute.String;
  };
}

export interface HomeExploreDeals extends Struct.ComponentSchema {
  collectionName: 'components_home_explore_deals';
  info: {
    displayName: 'Explore Deals Section';
    icon: 'grid';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    tabs: Schema.Attribute.Component<'home.explore-tab', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeExploreTab extends Struct.ComponentSchema {
  collectionName: 'components_home_explore_tabs';
  info: {
    displayName: 'Explore Deals Tab';
    icon: 'grid';
  };
  attributes: {
    category: Schema.Attribute.Relation<'oneToOne', 'api::category.category'>;
    deals: Schema.Attribute.Relation<'oneToMany', 'api::deal.deal'>;
    labelOverride: Schema.Attribute.String;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeFaqBlock extends Struct.ComponentSchema {
  collectionName: 'components_home_faq_blocks';
  info: {
    displayName: 'FAQ Section';
    icon: 'question';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    items: Schema.Attribute.Component<'shared.faq-item', true>;
  };
}

export interface HomeHeroProduct extends Struct.ComponentSchema {
  collectionName: 'components_home_hero_products';
  info: {
    displayName: 'Hero Product';
    icon: 'shoppingCart';
  };
  attributes: {
    deal: Schema.Attribute.Relation<'oneToOne', 'api::deal.deal'>;
    imageOverride: Schema.Attribute.Media<'images'>;
    linkOverride: Schema.Attribute.String;
    titleOverride: Schema.Attribute.String;
  };
}

export interface HomeHeroSection extends Struct.ComponentSchema {
  collectionName: 'components_home_hero_sections';
  info: {
    displayName: 'Hero Section';
    icon: 'picture';
  };
  attributes: {
    banners: Schema.Attribute.Component<'homepage.slider-slide', true>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    products: Schema.Attribute.Component<'home.hero-product', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
  };
}

export interface HomeHowItWorks extends Struct.ComponentSchema {
  collectionName: 'components_home_how_it_works';
  info: {
    displayName: 'How It Works Section';
    icon: 'information';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    features: Schema.Attribute.Component<'home.why-feature', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
    heading: Schema.Attribute.String;
    steps: Schema.Attribute.Component<'home.step', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 3;
        },
        number
      >;
  };
}

export interface HomeLatestInsights extends Struct.ComponentSchema {
  collectionName: 'components_home_latest_insights';
  info: {
    displayName: 'Latest Insights Section';
    icon: 'feather';
  };
  attributes: {
    heading: Schema.Attribute.String;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeNewlyAdded extends Struct.ComponentSchema {
  collectionName: 'components_home_newly_addeds';
  info: {
    displayName: 'Newly Added Stores Section';
    icon: 'plus';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    items: Schema.Attribute.Component<'home.coupon-card-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomePopularSearches extends Struct.ComponentSchema {
  collectionName: 'components_home_popular_searches';
  info: {
    displayName: 'Popular Searches Section';
    icon: 'search';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Popular Searches'>;
    links: Schema.Attribute.Component<'nav.link', true>;
  };
}

export interface HomePopularStores extends Struct.ComponentSchema {
  collectionName: 'components_home_popular_stores';
  info: {
    displayName: 'Popular Stores Section';
    icon: 'store';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    featuredStore: Schema.Attribute.Relation<'oneToOne', 'api::store.store'>;
    heading: Schema.Attribute.String;
    stores: Schema.Attribute.Relation<'oneToMany', 'api::store.store'>;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeStep extends Struct.ComponentSchema {
  collectionName: 'components_home_steps';
  info: {
    displayName: 'How It Works Step';
    icon: 'arrowRight';
  };
  attributes: {
    description: Schema.Attribute.Text;
    kind: Schema.Attribute.Enumeration<['store', 'copy', 'payments']> &
      Schema.Attribute.Required;
    title: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface HomeTopOfferItem extends Struct.ComponentSchema {
  collectionName: 'components_home_top_offer_items';
  info: {
    displayName: 'Top Offer Item';
    icon: 'gift';
  };
  attributes: {
    banner: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    coupon: Schema.Attribute.Relation<'oneToOne', 'api::coupon.coupon'>;
    linkOverride: Schema.Attribute.String;
    offerTextOverride: Schema.Attribute.String;
  };
}

export interface HomeTopOffers extends Struct.ComponentSchema {
  collectionName: 'components_home_top_offers';
  info: {
    displayName: 'Top Offers Section';
    icon: 'gift';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    items: Schema.Attribute.Component<'home.top-offer-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeWhyFeature extends Struct.ComponentSchema {
  collectionName: 'components_home_why_features';
  info: {
    displayName: 'Why Feature';
    icon: 'check';
  };
  attributes: {
    kind: Schema.Attribute.Enumeration<
      ['verified', 'update', 'store', 'block']
    > &
      Schema.Attribute.Required;
    label: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface HomepageSliderSlide extends Struct.ComponentSchema {
  collectionName: 'components_homepage_slider_slides';
  info: {
    displayName: 'Slider Slide';
    icon: 'picture';
  };
  attributes: {
    altText: Schema.Attribute.String;
    desktopImage: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    link: Schema.Attribute.String;
    mobileImage: Schema.Attribute.Media<'images'>;
    order: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
  };
}

export interface NavCategorySection extends Struct.ComponentSchema {
  collectionName: 'components_nav_category_sections';
  info: {
    displayName: 'Category Section';
    icon: 'folder';
  };
  attributes: {
    category: Schema.Attribute.Relation<'oneToOne', 'api::category.category'>;
    links: Schema.Attribute.Component<'nav.link', true>;
    title: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface NavLink extends Struct.ComponentSchema {
  collectionName: 'components_nav_links';
  info: {
    displayName: 'Nav Link';
    icon: 'link';
  };
  attributes: {
    bold: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    category: Schema.Attribute.Relation<'oneToOne', 'api::category.category'>;
    featured: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    label: Schema.Attribute.String;
    store: Schema.Attribute.Relation<'oneToOne', 'api::store.store'>;
    url: Schema.Attribute.String;
  };
}

export interface SharedChip extends Struct.ComponentSchema {
  collectionName: 'components_shared_chips';
  info: {
    displayName: 'Chip';
    icon: 'bulletList';
  };
  attributes: {
    label: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface SharedCta extends Struct.ComponentSchema {
  collectionName: 'components_shared_ctas';
  info: {
    displayName: 'CTA';
    icon: 'cursor';
  };
  attributes: {
    label: Schema.Attribute.String;
    url: Schema.Attribute.String;
  };
}

export interface SharedFaqItem extends Struct.ComponentSchema {
  collectionName: 'components_shared_faq_items';
  info: {
    displayName: 'FAQ Item';
    icon: 'question-circle';
  };
  attributes: {
    answer: Schema.Attribute.Text;
    question: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface SharedNewsletter extends Struct.ComponentSchema {
  collectionName: 'components_shared_newsletters';
  info: {
    displayName: 'Newsletter';
    icon: 'envelop';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    disclaimer: Schema.Attribute.String;
    heading: Schema.Attribute.String;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    displayName: 'SEO';
    icon: 'search';
  };
  attributes: {
    canonicalUrl: Schema.Attribute.String;
    metaDescription: Schema.Attribute.Text;
    metaTitle: Schema.Attribute.String;
    ogImage: Schema.Attribute.Media<'images'>;
  };
}

export interface SharedTelegramCta extends Struct.ComponentSchema {
  collectionName: 'components_shared_telegram_ctas';
  info: {
    displayName: 'Telegram CTA';
    icon: 'paperPlane';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String;
    ctaUrl: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'footer.country': FooterCountry;
      'footer.link-section': FooterLinkSection;
      'footer.partner-card': FooterPartnerCard;
      'footer.social-link': FooterSocialLink;
      'home.bank-offer-item': HomeBankOfferItem;
      'home.bank-offers': HomeBankOffers;
      'home.cg-exclusive': HomeCgExclusive;
      'home.coupon-card-item': HomeCouponCardItem;
      'home.deal-list': HomeDealList;
      'home.exclusive-item': HomeExclusiveItem;
      'home.explore-deals': HomeExploreDeals;
      'home.explore-tab': HomeExploreTab;
      'home.faq-block': HomeFaqBlock;
      'home.hero-product': HomeHeroProduct;
      'home.hero-section': HomeHeroSection;
      'home.how-it-works': HomeHowItWorks;
      'home.latest-insights': HomeLatestInsights;
      'home.newly-added': HomeNewlyAdded;
      'home.popular-searches': HomePopularSearches;
      'home.popular-stores': HomePopularStores;
      'home.step': HomeStep;
      'home.top-offer-item': HomeTopOfferItem;
      'home.top-offers': HomeTopOffers;
      'home.why-feature': HomeWhyFeature;
      'homepage.slider-slide': HomepageSliderSlide;
      'nav.category-section': NavCategorySection;
      'nav.link': NavLink;
      'shared.chip': SharedChip;
      'shared.cta': SharedCta;
      'shared.faq-item': SharedFaqItem;
      'shared.newsletter': SharedNewsletter;
      'shared.seo': SharedSeo;
      'shared.telegram-cta': SharedTelegramCta;
    }
  }
}
