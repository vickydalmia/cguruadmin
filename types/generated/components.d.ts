import type { Schema, Struct } from '@strapi/strapi';

export interface AboutFounder extends Struct.ComponentSchema {
  collectionName: 'components_about_founders';
  info: {
    description: 'Personal statement from the founder: portrait card with name and role, a large pull quote, then body paragraphs. The quotation marks around the pull quote are drawn by the component \u2014 do not type them into the field.';
    displayName: 'About Founder Letter';
    icon: 'user';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    paragraphs: Schema.Attribute.Component<'shared.paragraph', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 6;
        },
        number
      >;
    portrait: Schema.Attribute.Media<'images'>;
    portraitAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    pullQuote: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 400;
      }>;
    role: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
  };
}

export interface AboutHero extends Struct.ComponentSchema {
  collectionName: 'components_about_heroes';
  info: {
    description: "Top-of-page hero: glass eyebrow pill, headline, intro line and a full-bleed background photograph. This image is the page's LCP element \u2014 upload the largest original available (2880px wide or more); the site generates the responsive ladder.";
    displayName: 'About Hero';
    icon: 'picture';
  };
  attributes: {
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
    image: Schema.Attribute.Media<'images'>;
    imageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    subheading: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
  };
}

export interface AboutInternational extends Struct.ComponentSchema {
  collectionName: 'components_about_internationals';
  info: {
    description: 'Country flag cards. The countries themselves are NOT edited here \u2014 they come from the shared list in Footer \u2192 Countries, so the site has one home for them and the footer and this section can never disagree. Edit them there.';
    displayName: 'About International Presence';
    icon: 'globe';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
  };
}

export interface AboutJourney extends Struct.ComponentSchema {
  collectionName: 'components_about_journeys';
  info: {
    description: 'Dated company milestones on a connecting rail. Entries render in the order listed here \u2014 the design shows five, oldest first. Alternating left/right on desktop, single rail below 1024px.';
    displayName: 'About Journey Timeline';
    icon: 'clock';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
    milestones: Schema.Attribute.Component<'shared.milestone', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
  };
}

export interface AboutMissionVision extends Struct.ComponentSchema {
  collectionName: 'components_about_mission_visions';
  info: {
    description: 'Two dark pillar cards over a gradient stats band. The design uses exactly two pillars and four stats; fewer render fine, more are capped.';
    displayName: 'About Mission & Vision';
    icon: 'bulletList';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
    pillars: Schema.Attribute.Component<'shared.icon-card', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 2;
        },
        number
      >;
    stats: Schema.Attribute.Component<'shared.stat', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
  };
}

export interface AboutOurStory extends Struct.ComponentSchema {
  collectionName: 'components_about_our_stories';
  info: {
    description: 'Origin-story band: section header, prose paragraphs and a supporting photograph. Two columns on desktop, stacked below 768px with the image after the text.';
    displayName: 'About Our Story';
    icon: 'book';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
    image: Schema.Attribute.Media<'images'>;
    imageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    paragraphs: Schema.Attribute.Component<'shared.paragraph', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
  };
}

export interface AboutPress extends Struct.ComponentSchema {
  collectionName: 'components_about_presses';
  info: {
    description: '"As featured in" logo wall. Upload logos with transparent backgrounds at roughly 2x their rendered size (240px wide is plenty) \u2014 they sit on white cards and are weight-sensitive.';
    displayName: 'About Press Coverage';
    icon: 'star';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
    logos: Schema.Attribute.Component<'shared.logo-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 12;
        },
        number
      >;
  };
}

export interface AboutTrust extends Struct.ComponentSchema {
  collectionName: 'components_about_trusts';
  info: {
    description: 'Explains how offers are checked before publication: narrative column plus a grid of short feature cards. The grid stays two-up on mobile rather than collapsing to one.';
    displayName: 'About Trust & Verification';
    icon: 'shield';
  };
  attributes: {
    cards: Schema.Attribute.Component<'shared.icon-card', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
    paragraphs: Schema.Attribute.Component<'shared.paragraph', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 3;
        },
        number
      >;
  };
}

export interface CareerBenefitCard extends Struct.ComponentSchema {
  collectionName: 'components_career_benefit_cards';
  info: {
    displayName: 'Career Benefit Card';
    icon: 'star';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
    icon: Schema.Attribute.Enumeration<
      ['bolt', 'language', 'trending', 'favorite']
    > &
      Schema.Attribute.DefaultTo<'bolt'>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 70;
      }>;
  };
}

export interface CareerHero extends Struct.ComponentSchema {
  collectionName: 'components_career_heroes';
  info: {
    displayName: 'Career Hero';
    icon: 'briefcase';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    ctaUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 300;
      }>;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 700;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    image: Schema.Attribute.Media<'images'>;
    imageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    locationLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
  };
}

export interface CareerJobDetailCopy extends Struct.ComponentSchema {
  collectionName: 'components_career_job_detail_copies';
  info: {
    displayName: 'Job Detail Page Copy';
    icon: 'file';
  };
  attributes: {
    aboutEyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    aboutHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    benefitsEyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    benefitsHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    emailLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    emailPlaceholder: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    errorMessage: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 220;
      }>;
    formDescription: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 220;
      }>;
    formHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    heroImage: Schema.Attribute.Media<'images'>;
    heroImageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    linkedInLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    linkedInPlaceholder: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    messageLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    messagePlaceholder: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    moreJobsEyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    moreJobsHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    nameLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    namePlaceholder: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    phoneLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    phonePlaceholder: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    requirementsEyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    requirementsHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    responsibilitiesEyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    responsibilitiesHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    resumeHelper: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
    resumeLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    submitLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    successMessage: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 220;
      }>;
    uploadCtaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
  };
}

export interface CareerJobsSection extends Struct.ComponentSchema {
  collectionName: 'components_career_jobs_sections';
  info: {
    displayName: 'Career Jobs Section';
    icon: 'briefcase';
  };
  attributes: {
    applyLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    emptyMessage: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 220;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    resumeCtaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    resumeEmail: Schema.Attribute.Email;
    resumePrompt: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 220;
      }>;
  };
}

export interface CareerLife extends Struct.ComponentSchema {
  collectionName: 'components_career_life_sections';
  info: {
    displayName: 'Life at CouponzGuru';
    icon: 'picture';
  };
  attributes: {
    header: Schema.Attribute.Component<'shared.section-header', false>;
    image: Schema.Attribute.Media<'images'>;
    imageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    paragraphs: Schema.Attribute.Component<'shared.paragraph', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
  };
}

export interface CareerValueCard extends Struct.ComponentSchema {
  collectionName: 'components_career_value_cards';
  info: {
    displayName: 'Career Value';
    icon: 'heart';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 50;
      }>;
  };
}

export interface DealDayDealsByStore extends Struct.ComponentSchema {
  collectionName: 'components_deal_day_deals_by_stores';
  info: {
    displayName: 'Deal Day Deals By Store';
    icon: 'shoppingCart';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    tabs: Schema.Attribute.Component<'deal-day.store-tab', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface DealDaySectionHeading extends Struct.ComponentSchema {
  collectionName: 'components_deal_day_section_headings';
  info: {
    displayName: 'Deal Day Section Heading';
    icon: 'layout';
  };
  attributes: {
    deals: Schema.Attribute.Relation<'oneToMany', 'api::deal.deal'>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface DealDayStoreTab extends Struct.ComponentSchema {
  collectionName: 'components_deal_day_store_tabs';
  info: {
    displayName: 'Deal Day Store Tab';
    icon: 'shoppingCart';
  };
  attributes: {
    deals: Schema.Attribute.Relation<'oneToMany', 'api::deal.deal'>;
    labelOverride: Schema.Attribute.String;
    store: Schema.Attribute.Relation<'oneToOne', 'api::store.store'>;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface DealDayTelegramDeals extends Struct.ComponentSchema {
  collectionName: 'components_deal_day_telegram_deals';
  info: {
    displayName: 'Deal Day Telegram Deals';
    icon: 'paperPlane';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String;
    deals: Schema.Attribute.Relation<'oneToMany', 'api::deal.deal'>;
    description: Schema.Attribute.Text;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
  };
}

export interface ErrorPageExplore extends Struct.ComponentSchema {
  collectionName: 'components_error_page_explores';
  info: {
    displayName: 'Error Explore Section';
    icon: 'grid';
  };
  attributes: {
    couponsCard: Schema.Attribute.Component<'error-page.link-card', false>;
    electronicsCard: Schema.Attribute.Component<'error-page.link-card', false>;
    eyebrow: Schema.Attribute.String;
    heading: Schema.Attribute.String;
    storesCard: Schema.Attribute.Component<'error-page.link-card', false>;
    travelCard: Schema.Attribute.Component<'error-page.link-card', false>;
  };
}

export interface ErrorPageHero extends Struct.ComponentSchema {
  collectionName: 'components_error_page_heroes';
  info: {
    displayName: 'Error Hero';
    icon: 'warning';
  };
  attributes: {
    actionsLabel: Schema.Attribute.String;
    dealsCta: Schema.Attribute.Component<'shared.cta', false>;
    description: Schema.Attribute.Text;
    heading: Schema.Attribute.String;
    homeCta: Schema.Attribute.Component<'shared.cta', false>;
    searchButtonLabel: Schema.Attribute.String;
    searchLabel: Schema.Attribute.String;
    searchPlaceholder: Schema.Attribute.String;
    ticketDescription: Schema.Attribute.String;
    ticketTitle: Schema.Attribute.String & Schema.Attribute.DefaultTo<'OOPS!'>;
  };
}

export interface ErrorPageLinkCard extends Struct.ComponentSchema {
  collectionName: 'components_error_page_link_cards';
  info: {
    displayName: 'Error Discovery Card';
    icon: 'apps';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    mobileTitle: Schema.Attribute.String;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    url: Schema.Attribute.String;
  };
}

export interface ErrorPageTrustBanner extends Struct.ComponentSchema {
  collectionName: 'components_error_page_trust_banners';
  info: {
    displayName: 'Error Trust Banner';
    icon: 'shield';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    heading: Schema.Attribute.String;
    url: Schema.Attribute.String;
  };
}

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
          max: 12;
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
          max: 8;
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

export interface HomeExploreOfferTab extends Struct.ComponentSchema {
  collectionName: 'components_home_explore_offer_tabs';
  info: {
    displayName: 'Explore Offers Tab';
    icon: 'grid';
  };
  attributes: {
    category: Schema.Attribute.Relation<'oneToOne', 'api::category.category'>;
    labelOverride: Schema.Attribute.String;
    offers: Schema.Attribute.Relation<'oneToMany', 'api::coupon.coupon'>;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeExploreOffers extends Struct.ComponentSchema {
  collectionName: 'components_home_explore_offers';
  info: {
    displayName: 'Explore Offers Section';
    icon: 'grid';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    tabs: Schema.Attribute.Component<'home.explore-offer-tab', true> &
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
          max: 8;
        },
        number
      >;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface HomeOfferList extends Struct.ComponentSchema {
  collectionName: 'components_home_offer_lists';
  info: {
    displayName: 'Coupon Offer List Section';
    icon: 'priceTag';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    offers: Schema.Attribute.Relation<'oneToMany', 'api::coupon.coupon'>;
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
          max: 8;
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

export interface SharedBreadcrumbItem extends Struct.ComponentSchema {
  collectionName: 'components_shared_breadcrumb_items';
  info: {
    description: 'One step in a breadcrumb trail, ordered root first. Leave `url` empty on the final entry \u2014 the site renders the last item as the current page and never links it.';
    displayName: 'Breadcrumb Item';
    icon: 'chevronRight';
  };
  attributes: {
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    url: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
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

export interface SharedIconCard extends Struct.ComponentSchema {
  collectionName: 'components_shared_icon_cards';
  info: {
    description: 'Circular icon badge over a title and short body. Used by the Mission/Vision pillars and the trust-verification card grid. The icon is picked from a fixed set and rendered as inline SVG \u2014 no media upload, so it costs no extra request.';
    displayName: 'Icon Card';
    icon: 'grid';
  };
  attributes: {
    body: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
    iconKey: Schema.Attribute.Enumeration<
      [
        'search',
        'verified',
        'refresh',
        'ready',
        'target',
        'eye',
        'globe',
        'shield',
        'clock',
        'tag',
      ]
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'verified'>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
  };
}

export interface SharedLogoItem extends Struct.ComponentSchema {
  collectionName: 'components_shared_logo_items';
  info: {
    description: 'A publication or partner logo. `name` is required even though the design shows only the image \u2014 it supplies the alt text and the accessible name when the logo links out.';
    displayName: 'Logo Item';
    icon: 'picture';
  };
  attributes: {
    image: Schema.Attribute.Media<'images'>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    url: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
  };
}

export interface SharedMilestone extends Struct.ComponentSchema {
  collectionName: 'components_shared_milestones';
  info: {
    description: 'One dated entry on the company timeline. `year` is a string so "2011" and copy like "2026 \u2192" both render; the connecting rail between entries is drawn by the component.';
    displayName: 'Milestone';
    icon: 'clock';
  };
  attributes: {
    body: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
    regionLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    year: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 12;
      }>;
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
    emailLabel: Schema.Attribute.String;
    emailPlaceholder: Schema.Attribute.String;
    heading: Schema.Attribute.String;
    mobileHeading: Schema.Attribute.String;
  };
}

export interface SharedParagraph extends Struct.ComponentSchema {
  collectionName: 'components_shared_paragraphs';
  info: {
    description: 'One body paragraph. Repeatable so each block can be reordered and length-governed individually; the page never uses rich text for prose.';
    displayName: 'Paragraph';
    icon: 'align-justify';
  };
  attributes: {
    body: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 900;
      }>;
  };
}

export interface SharedSectionHeader extends Struct.ComponentSchema {
  collectionName: 'components_shared_section_headers';
  info: {
    description: 'Eyebrow label, heading and optional intro copy shared by every About page band. The accent bar beside the eyebrow is decorative and is drawn by the component, not stored here.';
    displayName: 'Section Header';
    icon: 'layout';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
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
    metaDescription: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 170;
      }>;
    metaTitle: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 70;
      }>;
    noIndex: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    ogDescription: Schema.Attribute.Text;
    ogImage: Schema.Attribute.Media<'images'>;
    ogImageAlt: Schema.Attribute.String;
    ogTitle: Schema.Attribute.String;
  };
}

export interface SharedStat extends Struct.ComponentSchema {
  collectionName: 'components_shared_stats';
  info: {
    description: 'One figure in a stats band. `value` is deliberately a string, not a number \u2014 the design renders "5,000+", "6" and "100%" in the same row.';
    displayName: 'Stat';
    icon: 'chartBubble';
  };
  attributes: {
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    value: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 16;
      }>;
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
      'about.founder': AboutFounder;
      'about.hero': AboutHero;
      'about.international': AboutInternational;
      'about.journey': AboutJourney;
      'about.mission-vision': AboutMissionVision;
      'about.our-story': AboutOurStory;
      'about.press': AboutPress;
      'about.trust': AboutTrust;
      'career.benefit-card': CareerBenefitCard;
      'career.hero': CareerHero;
      'career.job-detail-copy': CareerJobDetailCopy;
      'career.jobs-section': CareerJobsSection;
      'career.life': CareerLife;
      'career.value-card': CareerValueCard;
      'deal-day.deals-by-store': DealDayDealsByStore;
      'deal-day.section-heading': DealDaySectionHeading;
      'deal-day.store-tab': DealDayStoreTab;
      'deal-day.telegram-deals': DealDayTelegramDeals;
      'error-page.explore': ErrorPageExplore;
      'error-page.hero': ErrorPageHero;
      'error-page.link-card': ErrorPageLinkCard;
      'error-page.trust-banner': ErrorPageTrustBanner;
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
      'home.explore-offer-tab': HomeExploreOfferTab;
      'home.explore-offers': HomeExploreOffers;
      'home.explore-tab': HomeExploreTab;
      'home.faq-block': HomeFaqBlock;
      'home.hero-product': HomeHeroProduct;
      'home.hero-section': HomeHeroSection;
      'home.how-it-works': HomeHowItWorks;
      'home.latest-insights': HomeLatestInsights;
      'home.newly-added': HomeNewlyAdded;
      'home.offer-list': HomeOfferList;
      'home.popular-searches': HomePopularSearches;
      'home.popular-stores': HomePopularStores;
      'home.step': HomeStep;
      'home.top-offer-item': HomeTopOfferItem;
      'home.top-offers': HomeTopOffers;
      'home.why-feature': HomeWhyFeature;
      'homepage.slider-slide': HomepageSliderSlide;
      'nav.category-section': NavCategorySection;
      'nav.link': NavLink;
      'shared.breadcrumb-item': SharedBreadcrumbItem;
      'shared.cta': SharedCta;
      'shared.faq-item': SharedFaqItem;
      'shared.icon-card': SharedIconCard;
      'shared.logo-item': SharedLogoItem;
      'shared.milestone': SharedMilestone;
      'shared.newsletter': SharedNewsletter;
      'shared.paragraph': SharedParagraph;
      'shared.section-header': SharedSectionHeader;
      'shared.seo': SharedSeo;
      'shared.stat': SharedStat;
      'shared.telegram-cta': SharedTelegramCta;
    }
  }
}
