import type { Schema, Struct } from '@strapi/strapi';

export interface AdminApiToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_tokens';
  info: {
    description: '';
    displayName: 'Api Token';
    name: 'Api Token';
    pluralName: 'api-tokens';
    singularName: 'api-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    adminPermissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::permission'
    >;
    adminUserOwner: Schema.Attribute.Relation<'manyToOne', 'admin::user'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    encryptedKey: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    expiresAt: Schema.Attribute.DateTime;
    kind: Schema.Attribute.Enumeration<['content-api', 'admin']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'content-api'>;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::api-token-permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.Enumeration<['read-only', 'full-access', 'custom']> &
      Schema.Attribute.DefaultTo<'read-only'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminApiTokenPermission extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_token_permissions';
  info: {
    description: '';
    displayName: 'API Token Permission';
    name: 'API Token Permission';
    pluralName: 'api-token-permissions';
    singularName: 'api-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::api-token-permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminPermission extends Struct.CollectionTypeSchema {
  collectionName: 'admin_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'Permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    actionParameters: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    apiToken: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    conditions: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<[]>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::permission'> &
      Schema.Attribute.Private;
    properties: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<'manyToOne', 'admin::role'>;
    subject: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminRole extends Struct.CollectionTypeSchema {
  collectionName: 'admin_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'Role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::role'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<'oneToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users: Schema.Attribute.Relation<'manyToMany', 'admin::user'>;
  };
}

export interface AdminSession extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_sessions';
  info: {
    description: 'Session Manager storage';
    displayName: 'Session';
    name: 'Session';
    pluralName: 'sessions';
    singularName: 'session';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
    i18n: {
      localized: false;
    };
  };
  attributes: {
    absoluteExpiresAt: Schema.Attribute.DateTime & Schema.Attribute.Private;
    childId: Schema.Attribute.String & Schema.Attribute.Private;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deviceId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    expiresAt: Schema.Attribute.DateTime &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::session'> &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON & Schema.Attribute.Private;
    origin: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    sessionId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique;
    status: Schema.Attribute.String & Schema.Attribute.Private;
    type: Schema.Attribute.String & Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    userId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
  };
}

export interface AdminTransferToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_tokens';
  info: {
    description: '';
    displayName: 'Transfer Token';
    name: 'Transfer Token';
    pluralName: 'transfer-tokens';
    singularName: 'transfer-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    expiresAt: Schema.Attribute.DateTime;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token-permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminTransferTokenPermission
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_token_permissions';
  info: {
    description: '';
    displayName: 'Transfer Token Permission';
    name: 'Transfer Token Permission';
    pluralName: 'transfer-token-permissions';
    singularName: 'transfer-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token-permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::transfer-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminUser extends Struct.CollectionTypeSchema {
  collectionName: 'admin_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'User';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    apiTokens: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> &
      Schema.Attribute.Private;
    blocked: Schema.Attribute.Boolean &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    firstname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    isActive: Schema.Attribute.Boolean &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<false>;
    lastname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::user'> &
      Schema.Attribute.Private;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    preferedLanguage: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    registrationToken: Schema.Attribute.String & Schema.Attribute.Private;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    roles: Schema.Attribute.Relation<'manyToMany', 'admin::role'> &
      Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    username: Schema.Attribute.String;
  };
}

export interface ApiAboutPageAboutPage extends Struct.SingleTypeSchema {
  collectionName: 'about_pages';
  info: {
    description: 'Every piece of copy, image and link on the public /about-us/ page. Sections render in the fixed order shown here; each can be switched off with its own Enabled toggle.';
    displayName: 'About Page';
    pluralName: 'about-pages';
    singularName: 'about-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    founder: Schema.Attribute.Component<'about.founder', false>;
    hero: Schema.Attribute.Component<'about.hero', false>;
    international: Schema.Attribute.Component<'about.international', false>;
    journey: Schema.Attribute.Component<'about.journey', false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::about-page.about-page'
    > &
      Schema.Attribute.Private;
    missionVision: Schema.Attribute.Component<'about.mission-vision', false>;
    ourStory: Schema.Attribute.Component<'about.our-story', false>;
    press: Schema.Attribute.Component<'about.press', false>;
    publishedAt: Schema.Attribute.DateTime;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    title: Schema.Attribute.String & Schema.Attribute.DefaultTo<'About Page'>;
    trust: Schema.Attribute.Component<'about.trust', false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAffiliateDisclosurePageAffiliateDisclosurePage
  extends Struct.SingleTypeSchema {
  collectionName: 'affiliate_disclosure_pages';
  info: {
    description: 'Editable copy, ordered disclosure sections and SEO for the public /affiliate-disclosure/ page. This document renders in the full-width layout, so navigationItems and supportCta are unused by the storefront and are kept only for parity with the other legal single types.';
    displayName: 'Affiliate Disclosure Page';
    pluralName: 'affiliate-disclosure-pages';
    singularName: 'affiliate-disclosure-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    contentHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    effectiveDate: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::affiliate-disclosure-page.affiliate-disclosure-page'
    > &
      Schema.Attribute.Private;
    navigationItems: Schema.Attribute.Component<'legal.navigation-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 12;
        },
        number
      >;
    navigationTitle: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    publishedAt: Schema.Attribute.DateTime;
    sections: Schema.Attribute.Component<'legal.section', true>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    supportCta: Schema.Attribute.Component<'legal.support-cta', false>;
    title: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Affiliate Disclosure'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiBankBank extends Struct.CollectionTypeSchema {
  collectionName: 'banks';
  info: {
    description: 'Financial institutions (HDFC, ICICI, SBI Card, Axis Bank)';
    displayName: 'Bank';
    pluralName: 'banks';
    singularName: 'bank';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    coupons: Schema.Attribute.Relation<'manyToMany', 'api::coupon.coupon'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deals: Schema.Attribute.Relation<'manyToMany', 'api::deal.deal'>;
    description: Schema.Attribute.RichText;
    entityDealPageSeo: Schema.Attribute.Component<
      'shared.entity-deal-page-seo',
      false
    >;
    faqEnabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    faqs: Schema.Attribute.Component<'shared.faq-item', true>;
    isVerified: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::bank.bank'> &
      Schema.Attribute.Private;
    logo: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    logoAlt: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    orderedCoupons: Schema.Attribute.Relation<
      'manyToMany',
      'api::coupon.coupon'
    >;
    publishedAt: Schema.Attribute.DateTime;
    ratingAverage: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
          min: 0;
        },
        number
      >;
    ratingCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    shortDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    showTrendingDeals: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<true>;
    slug: Schema.Attribute.String & Schema.Attribute.Required;
    topPickCoupons: Schema.Attribute.Relation<
      'manyToMany',
      'api::coupon.coupon'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    websiteUrl: Schema.Attribute.String;
  };
}

export interface ApiBrandBrand extends Struct.CollectionTypeSchema {
  collectionName: 'brands';
  info: {
    description: "Brands (Nike, Samsung, Apple, Levi's)";
    displayName: 'Brand';
    pluralName: 'brands';
    singularName: 'brand';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    coupons: Schema.Attribute.Relation<'manyToMany', 'api::coupon.coupon'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deals: Schema.Attribute.Relation<'manyToMany', 'api::deal.deal'>;
    description: Schema.Attribute.RichText;
    entityDealPageSeo: Schema.Attribute.Component<
      'shared.entity-deal-page-seo',
      false
    >;
    faqEnabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    faqs: Schema.Attribute.Component<'shared.faq-item', true>;
    isVerified: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::brand.brand'> &
      Schema.Attribute.Private;
    logo: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    logoAlt: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    orderedCoupons: Schema.Attribute.Relation<
      'manyToMany',
      'api::coupon.coupon'
    >;
    publishedAt: Schema.Attribute.DateTime;
    ratingAverage: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
          min: 0;
        },
        number
      >;
    ratingCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    shortDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    showTrendingDeals: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<true>;
    slug: Schema.Attribute.String & Schema.Attribute.Required;
    topPickCoupons: Schema.Attribute.Relation<
      'manyToMany',
      'api::coupon.coupon'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    websiteUrl: Schema.Attribute.String;
  };
}

export interface ApiCareerPageCareerPage extends Struct.SingleTypeSchema {
  collectionName: 'career_pages';
  info: {
    description: 'All editable copy and media shared by the Careers listing and job detail pages. Missing fields use the deployed Figma fallback.';
    displayName: 'Career Page';
    pluralName: 'career-pages';
    singularName: 'career-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    benefits: Schema.Attribute.Component<'career.benefit-card', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
    careersBreadcrumbLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Careers'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    hero: Schema.Attribute.Component<'career.hero', false>;
    homeBreadcrumbLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Home'>;
    jobDetail: Schema.Attribute.Component<'career.job-detail-copy', false>;
    jobsSection: Schema.Attribute.Component<'career.jobs-section', false>;
    life: Schema.Attribute.Component<'career.life', false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::career-page.career-page'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    title: Schema.Attribute.String & Schema.Attribute.DefaultTo<'Career Page'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    values: Schema.Attribute.Component<'career.value-card', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
    whyJoinHeader: Schema.Attribute.Component<'shared.section-header', false>;
  };
}

export interface ApiCategoryCategory extends Struct.CollectionTypeSchema {
  collectionName: 'categories';
  info: {
    description: 'Product categories (Electronics, Fashion, Travel, Food)';
    displayName: 'Category';
    pluralName: 'categories';
    singularName: 'category';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    coupons: Schema.Attribute.Relation<'manyToMany', 'api::coupon.coupon'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deals: Schema.Attribute.Relation<'manyToMany', 'api::deal.deal'>;
    description: Schema.Attribute.RichText;
    entityDealPageSeo: Schema.Attribute.Component<
      'shared.entity-deal-page-seo',
      false
    >;
    faqEnabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    faqs: Schema.Attribute.Component<'shared.faq-item', true>;
    icon: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    iconAlt: Schema.Attribute.String & Schema.Attribute.Required;
    isVerified: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::category.category'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    orderedCoupons: Schema.Attribute.Relation<
      'manyToMany',
      'api::coupon.coupon'
    >;
    publishedAt: Schema.Attribute.DateTime;
    ratingAverage: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
          min: 0;
        },
        number
      >;
    ratingCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    shortDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    showTrendingDeals: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<true>;
    slug: Schema.Attribute.String & Schema.Attribute.Required;
    topPickCoupons: Schema.Attribute.Relation<
      'manyToMany',
      'api::coupon.coupon'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    websiteUrl: Schema.Attribute.String;
  };
}

export interface ApiContactPageContactPage extends Struct.SingleTypeSchema {
  collectionName: 'contact_pages';
  info: {
    description: 'All editable copy, contact links, form options, hero media and SEO for the public /contact-us/ page.';
    displayName: 'Contact Page';
    pluralName: 'contact-pages';
    singularName: 'contact-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    contactInformationHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    contactMethods: Schema.Attribute.Component<'contact.contact-method', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 3;
        },
        number
      >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    form: Schema.Attribute.Component<'contact.form', false>;
    hero: Schema.Attribute.Component<'contact.hero', false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::contact-page.contact-page'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    title: Schema.Attribute.String & Schema.Attribute.DefaultTo<'Contact Us'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiCouponCoupon extends Struct.CollectionTypeSchema {
  collectionName: 'coupons';
  info: {
    description: 'Coupon codes (static and unique) for stores, banks, categories, and brands';
    displayName: 'Coupon';
    pluralName: 'coupons';
    singularName: 'coupon';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    affiliateLink: Schema.Attribute.Text & Schema.Attribute.Required;
    badge: Schema.Attribute.Enumeration<
      [
        'CG Exclusive',
        'Recommended',
        'Top Rated',
        'Best Seller',
        'Expiring Soon',
        'LOOT Deal',
      ]
    >;
    bankOfferText: Schema.Attribute.String;
    banks: Schema.Attribute.Relation<'manyToMany', 'api::bank.bank'>;
    brands: Schema.Attribute.Relation<'manyToMany', 'api::brand.brand'>;
    cashbackText: Schema.Attribute.String;
    categories: Schema.Attribute.Relation<
      'manyToMany',
      'api::category.category'
    >;
    code: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 64;
      }>;
    content: Schema.Attribute.RichText &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 50000;
      }>;
    contentStatus: Schema.Attribute.Enumeration<
      ['published', 'scheduled', 'expired']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'published'>;
    couponType: Schema.Attribute.Enumeration<['static', 'unique']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'static'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    expiresAt: Schema.Attribute.DateTime;
    failedCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::coupon.coupon'
    > &
      Schema.Attribute.Private;
    logoStore: Schema.Attribute.Relation<'manyToOne', 'api::store.store'>;
    offerText: Schema.Attribute.String & Schema.Attribute.Required;
    prepaidText: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    publishedOn: Schema.Attribute.DateTime;
    scheduledAt: Schema.Attribute.DateTime;
    stores: Schema.Attribute.Relation<'manyToMany', 'api::store.store'>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
    uniqueCouponPool: Schema.Attribute.Relation<
      'manyToOne',
      'api::unique-coupon-pool.unique-coupon-pool'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    workedCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
  };
}

export interface ApiCulturePageCulturePage extends Struct.SingleTypeSchema {
  collectionName: 'culture_pages';
  info: {
    description: 'Editable copy, stats, values, team photo gallery, testimonials, timeline and hiring banner for the public /culture/ page.';
    displayName: 'Culture Page';
    pluralName: 'culture-pages';
    singularName: 'culture-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    gallery: Schema.Attribute.Component<'culture.gallery', false>;
    hero: Schema.Attribute.Component<'culture.hero', false>;
    journey: Schema.Attribute.Component<'culture.journey', false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::culture-page.culture-page'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    recruitment: Schema.Attribute.Component<'culture.recruitment', false>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    stats: Schema.Attribute.Component<'culture.stat', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 6;
        },
        number
      >;
    testimonials: Schema.Attribute.Component<'culture.testimonials', false>;
    title: Schema.Attribute.String & Schema.Attribute.DefaultTo<'Culture'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    values: Schema.Attribute.Component<'culture.values', false>;
  };
}

export interface ApiDealOfTheDayPageDealOfTheDayPage
  extends Struct.SingleTypeSchema {
  collectionName: 'deal_of_the_day_pages';
  info: {
    description: 'Curated sections for the deal-of-the-day category landing page';
    displayName: 'Deal of the Day Page';
    pluralName: 'deal-of-the-day-pages';
    singularName: 'deal-of-the-day-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    allDeals: Schema.Attribute.Component<'deal-day.section-heading', false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    dealsByCategory: Schema.Attribute.Component<'home.explore-deals', false>;
    dealsByStore: Schema.Attribute.Component<'deal-day.deals-by-store', false>;
    genZDrops: Schema.Attribute.Component<'home.deal-list', false>;
    heroSubtitle: Schema.Attribute.String;
    heroTitle: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::deal-of-the-day-page.deal-of-the-day-page'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    smartSavingStack: Schema.Attribute.Component<'home.deal-list', false>;
    telegramDeals: Schema.Attribute.Component<'deal-day.telegram-deals', false>;
    title: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Deal of the Day Page'>;
    topDeals: Schema.Attribute.Component<'home.deal-list', false>;
    topPicks: Schema.Attribute.Component<'home.deal-list', false>;
    trendingNow: Schema.Attribute.Component<'home.deal-list', false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiDealDeal extends Struct.CollectionTypeSchema {
  collectionName: 'deals';
  info: {
    description: 'Product deals with pricing, images, and affiliate links';
    displayName: 'Product Deal';
    pluralName: 'deals';
    singularName: 'deal';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    affiliateLink: Schema.Attribute.Text & Schema.Attribute.Required;
    badge: Schema.Attribute.Enumeration<
      [
        'CG Exclusive',
        'Recommended',
        'Top Rated',
        'Best Seller',
        'Expiring Soon',
        'LOOT Deal',
      ]
    >;
    bankOfferText: Schema.Attribute.String;
    banks: Schema.Attribute.Relation<'manyToMany', 'api::bank.bank'>;
    brands: Schema.Attribute.Relation<'manyToMany', 'api::brand.brand'>;
    cashbackText: Schema.Attribute.String;
    categories: Schema.Attribute.Relation<
      'manyToMany',
      'api::category.category'
    >;
    code: Schema.Attribute.Text;
    content: Schema.Attribute.RichText &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 50000;
      }>;
    contentStatus: Schema.Attribute.Enumeration<
      ['published', 'scheduled', 'expired']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'published'>;
    couponType: Schema.Attribute.Enumeration<['static', 'unique']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'static'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    dealImage: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    discount: Schema.Attribute.String;
    discountPrefix: Schema.Attribute.Enumeration<
      ['flat', 'upTo', 'extra', 'min', 'under', 'below']
    >;
    expiresAt: Schema.Attribute.DateTime;
    failedCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::deal.deal'> &
      Schema.Attribute.Private;
    logoStore: Schema.Attribute.Relation<'manyToOne', 'api::store.store'>;
    mrp: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    prepaidText: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    publishedOn: Schema.Attribute.DateTime;
    salePrice: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    scheduledAt: Schema.Attribute.DateTime;
    stores: Schema.Attribute.Relation<'manyToMany', 'api::store.store'>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
    uniqueCouponPool: Schema.Attribute.Relation<
      'manyToOne',
      'api::unique-coupon-pool.unique-coupon-pool'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    workedCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
  };
}

export interface ApiErrorPageErrorPage extends Struct.SingleTypeSchema {
  collectionName: 'error_pages';
  info: {
    displayName: 'Error Page';
    pluralName: 'error-pages';
    singularName: 'error-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    explore: Schema.Attribute.Component<'error-page.explore', false>;
    hero: Schema.Attribute.Component<'error-page.hero', false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::error-page.error-page'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    title: Schema.Attribute.String & Schema.Attribute.DefaultTo<'Error Page'>;
    trustBanner: Schema.Attribute.Component<'error-page.trust-banner', false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiFaqPageFaqPage extends Struct.SingleTypeSchema {
  collectionName: 'faq_pages';
  info: {
    description: 'All editable copy, categories, questions and SEO for the public /faqs/ page. Category and question order follows the order configured here.';
    displayName: 'FAQ Page';
    pluralName: 'faq-pages';
    singularName: 'faq-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    categories: Schema.Attribute.Component<'faq.category', true>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::faq-page.faq-page'
    > &
      Schema.Attribute.Private;
    noResultsMessage: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    publishedAt: Schema.Attribute.DateTime;
    searchPlaceholder: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    supportCta: Schema.Attribute.Component<'faq.support-cta', false>;
    title: Schema.Attribute.String & Schema.Attribute.DefaultTo<'FAQ Page'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiFooterFooter extends Struct.SingleTypeSchema {
  collectionName: 'footers';
  info: {
    description: 'Footer link sections, socials, countries, partner and Google Preferred cards';
    displayName: 'Footer';
    pluralName: 'footers';
    singularName: 'footer';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    badgeText: Schema.Attribute.String;
    copyrightText: Schema.Attribute.String;
    countries: Schema.Attribute.Component<'footer.country', true>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    googlePreferredCard: Schema.Attribute.Component<
      'footer.google-preferred-card',
      false
    >;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::footer.footer'
    > &
      Schema.Attribute.Private;
    partnerCard: Schema.Attribute.Component<'footer.partner-card', false>;
    publishedAt: Schema.Attribute.DateTime;
    sections: Schema.Attribute.Component<'footer.link-section', true>;
    socialLinks: Schema.Attribute.Component<'footer.social-link', true>;
    title: Schema.Attribute.String & Schema.Attribute.DefaultTo<'Footer'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiGlobalGlobal extends Struct.SingleTypeSchema {
  collectionName: 'globals';
  info: {
    displayName: 'Global Settings';
    pluralName: 'globals';
    singularName: 'global';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    footerCode: Schema.Attribute.Text;
    headerCode: Schema.Attribute.Text;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::global.global'
    > &
      Schema.Attribute.Private;
    newsletter: Schema.Attribute.Component<'shared.newsletter', false>;
    publishedAt: Schema.Attribute.DateTime;
    telegramCta: Schema.Attribute.Component<'shared.telegram-cta', false>;
    title: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Global Settings'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiHomepageHomepage extends Struct.SingleTypeSchema {
  collectionName: 'homepages';
  info: {
    displayName: 'Homepage';
    pluralName: 'homepages';
    singularName: 'homepage';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bankOffers: Schema.Attribute.Component<'home.bank-offers', false>;
    cgExclusive: Schema.Attribute.Component<'home.cg-exclusive', false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    dealsByBrand: Schema.Attribute.Component<'home.deal-list', false>;
    exploreDeals: Schema.Attribute.Component<'home.explore-deals', false>;
    exploreOffers: Schema.Attribute.Component<'home.explore-offers', false>;
    faq: Schema.Attribute.Component<'home.faq-block', false>;
    hero: Schema.Attribute.Component<'home.hero-section', false>;
    howItWorks: Schema.Attribute.Component<'home.how-it-works', false>;
    latestInsights: Schema.Attribute.Component<'home.latest-insights', false>;
    latestInsightsEnabled: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::homepage.homepage'
    > &
      Schema.Attribute.Private;
    newlyAdded: Schema.Attribute.Component<'home.newly-added', false>;
    offersByBrand: Schema.Attribute.Component<'home.offer-list', false>;
    popularSearches: Schema.Attribute.Component<'home.popular-searches', false>;
    popularStores: Schema.Attribute.Component<'home.popular-stores', false>;
    publishedAt: Schema.Attribute.DateTime;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    title: Schema.Attribute.String & Schema.Attribute.DefaultTo<'Homepage'>;
    topDeals: Schema.Attribute.Component<'home.deal-list', false>;
    topOffers: Schema.Attribute.Component<'home.top-offers', false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiJobJob extends Struct.CollectionTypeSchema {
  collectionName: 'jobs';
  info: {
    description: 'Career openings shown on /careers and their detail pages.';
    displayName: 'Job';
    pluralName: 'jobs';
    singularName: 'job';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    benefits: Schema.Attribute.Component<'shared.paragraph', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 16;
        },
        number
      >;
    category: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    employmentType: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    experience: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::job.job'> &
      Schema.Attribute.Private;
    location: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    opportunityParagraphs: Schema.Attribute.Component<
      'shared.paragraph',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 6;
        },
        number
      >;
    publishedAt: Schema.Attribute.DateTime;
    requirements: Schema.Attribute.Component<'shared.paragraph', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 16;
        },
        number
      >;
    responsibilities: Schema.Attribute.Component<'shared.paragraph', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 16;
        },
        number
      >;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    slug: Schema.Attribute.String & Schema.Attribute.Required;
    sortOrder: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiMenuMenu extends Struct.SingleTypeSchema {
  collectionName: 'menus';
  info: {
    description: 'Site header navigation, search suggestions, and active notifications';
    displayName: 'Header Settings';
    pluralName: 'menus';
    singularName: 'menu';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    categoriesLabel: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Categories'>;
    categoriesPopularStoresTitle: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Popular Stores'>;
    categoriesTitle: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'All Categories'>;
    categoriesViewAllUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }> &
      Schema.Attribute.DefaultTo<'/categories/'>;
    categorySections: Schema.Attribute.Component<'nav.category-section', true>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    extraItems: Schema.Attribute.Component<'nav.link', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::menu.menu'> &
      Schema.Attribute.Private;
    notification: Schema.Attribute.Component<'header.notification', false>;
    publishedAt: Schema.Attribute.DateTime;
    searchSuggestions: Schema.Attribute.Component<
      'header.search-suggestion',
      true
    >;
    searchTopStores: Schema.Attribute.Component<
      'header.search-top-store',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
    title: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Header Settings'>;
    topStores: Schema.Attribute.Relation<'oneToMany', 'api::store.store'> &
      Schema.Attribute.SetMinMax<
        {
          max: 18;
        },
        number
      >;
    topStoresLabel: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Top Stores'>;
    topStoresTitle: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'All Stores'>;
    topStoresViewAllUrl: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'/stores/'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiPartnerWithUsPagePartnerWithUsPage
  extends Struct.SingleTypeSchema {
  collectionName: 'partner_with_us_pages';
  info: {
    description: 'All editable copy, hero media, logos, marketing sections, CTAs and SEO for /partner-with-us/. Empty fields use the committed Figma fallback.';
    displayName: 'Partner With Us Page';
    pluralName: 'partner-with-us-pages';
    singularName: 'partner-with-us-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    benefits: Schema.Attribute.Component<'partner.benefits-section', false>;
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    cta: Schema.Attribute.Component<'partner.cta', false>;
    exposure: Schema.Attribute.Component<'partner.exposure-section', false>;
    hero: Schema.Attribute.Component<'partner.hero', false>;
    impact: Schema.Attribute.Component<'partner.impact-section', false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::partner-with-us-page.partner-with-us-page'
    > &
      Schema.Attribute.Private;
    partnerships: Schema.Attribute.Component<
      'partner.partnerships-section',
      false
    >;
    publishedAt: Schema.Attribute.DateTime;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    support: Schema.Attribute.Component<'partner.support-section', false>;
    title: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Partner With Us Page'>;
    trusted: Schema.Attribute.Component<'partner.trusted-section', false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiPrivacyPolicyPagePrivacyPolicyPage
  extends Struct.SingleTypeSchema {
  collectionName: 'privacy_policy_pages';
  info: {
    description: 'Editable copy, ordered policy sections, sidebar links and SEO for the public /privacy-policy/ page.';
    displayName: 'Privacy Policy Page';
    pluralName: 'privacy-policy-pages';
    singularName: 'privacy-policy-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    contentHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    effectiveDate: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::privacy-policy-page.privacy-policy-page'
    > &
      Schema.Attribute.Private;
    navigationItems: Schema.Attribute.Component<'legal.navigation-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 12;
        },
        number
      >;
    navigationTitle: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    publishedAt: Schema.Attribute.DateTime;
    sections: Schema.Attribute.Component<'legal.section', true>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    supportCta: Schema.Attribute.Component<'legal.support-cta', false>;
    title: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Privacy Policy'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiRedirectRedirect extends Struct.CollectionTypeSchema {
  collectionName: 'redirects';
  info: {
    description: 'Editor-managed URL redirects, applied by the ISR frontend middleware before any built-in canonicalisation.';
    displayName: 'Redirect';
    pluralName: 'redirects';
    singularName: 'redirect';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    active: Schema.Attribute.Boolean &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<true>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    from: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 512;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::redirect.redirect'
    > &
      Schema.Attribute.Private;
    note: Schema.Attribute.Text &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    publishedAt: Schema.Attribute.DateTime;
    statusCode: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          max: 302;
          min: 301;
        },
        number
      > &
      Schema.Attribute.DefaultTo<301>;
    to: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 1024;
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiStoreStore extends Struct.CollectionTypeSchema {
  collectionName: 'stores';
  info: {
    description: 'E-commerce stores (Amazon, Flipkart, Myntra, etc.)';
    displayName: 'Store';
    pluralName: 'stores';
    singularName: 'store';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    coupons: Schema.Attribute.Relation<'manyToMany', 'api::coupon.coupon'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deals: Schema.Attribute.Relation<'manyToMany', 'api::deal.deal'>;
    description: Schema.Attribute.RichText;
    entityDealPageSeo: Schema.Attribute.Component<
      'shared.entity-deal-page-seo',
      false
    >;
    faqEnabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    faqs: Schema.Attribute.Component<'shared.faq-item', true>;
    isCjEnabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    isVerified: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::store.store'> &
      Schema.Attribute.Private;
    logo: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    logoAlt: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    orderedCoupons: Schema.Attribute.Relation<
      'manyToMany',
      'api::coupon.coupon'
    >;
    publishedAt: Schema.Attribute.DateTime;
    ratingAverage: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
          min: 0;
        },
        number
      >;
    ratingCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    shortDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    showTrendingDeals: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<true>;
    slug: Schema.Attribute.String & Schema.Attribute.Required;
    topPickCoupons: Schema.Attribute.Relation<
      'manyToMany',
      'api::coupon.coupon'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    websiteUrl: Schema.Attribute.String;
  };
}

export interface ApiTermsAndConditionsPageTermsAndConditionsPage
  extends Struct.SingleTypeSchema {
  collectionName: 'terms_and_conditions_pages';
  info: {
    description: 'Editable copy, ordered terms sections, sidebar links and SEO for the public /terms-and-conditions/ page.';
    displayName: 'Terms & Conditions Page';
    pluralName: 'terms-and-conditions-pages';
    singularName: 'terms-and-conditions-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    contentHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    effectiveDate: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::terms-and-conditions-page.terms-and-conditions-page'
    > &
      Schema.Attribute.Private;
    navigationItems: Schema.Attribute.Component<'legal.navigation-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 12;
        },
        number
      >;
    navigationTitle: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    publishedAt: Schema.Attribute.DateTime;
    sections: Schema.Attribute.Component<'legal.section', true>;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    supportCta: Schema.Attribute.Component<'legal.support-cta', false>;
    title: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Terms & Conditions'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiTestimonialsPageTestimonialsPage
  extends Struct.SingleTypeSchema {
  collectionName: 'testimonials_pages';
  info: {
    description: 'All editable copy, portraits, testimonial cards, CTA, FAQs and SEO for the public /testimonials/ page. The storefront uses the committed Figma content wherever a field has not yet been populated.';
    displayName: 'Testimonials Page';
    pluralName: 'testimonials-pages';
    singularName: 'testimonials-page';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    breadcrumbAriaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }> &
      Schema.Attribute.DefaultTo<'Breadcrumb'>;
    breadcrumbItems: Schema.Attribute.Component<
      'shared.breadcrumb-item',
      true
    > &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
        },
        number
      >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    faq: Schema.Attribute.Component<'testimonial.faq-section', false>;
    featured: Schema.Attribute.Component<'testimonial.featured-section', false>;
    hero: Schema.Attribute.Component<'testimonial.hero', false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::testimonials-page.testimonials-page'
    > &
      Schema.Attribute.Private;
    partnerCta: Schema.Attribute.Component<'testimonial.partner-cta', false>;
    partners: Schema.Attribute.Component<'testimonial.partners-section', false>;
    publishedAt: Schema.Attribute.DateTime;
    seo: Schema.Attribute.Component<'shared.seo', false>;
    title: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Testimonials Page'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiUniqueCodeUniqueCode extends Struct.CollectionTypeSchema {
  collectionName: 'unique_codes';
  info: {
    description: 'Individual unique coupon codes managed by pools';
    displayName: 'Unique Code';
    pluralName: 'unique-codes';
    singularName: 'unique-code';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: true;
    };
    'content-type-builder': {
      visible: true;
    };
  };
  attributes: {
    claimToken: Schema.Attribute.String & Schema.Attribute.Private;
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    isUsed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::unique-code.unique-code'
    > &
      Schema.Attribute.Private;
    pool: Schema.Attribute.Relation<
      'manyToOne',
      'api::unique-coupon-pool.unique-coupon-pool'
    >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    usedAt: Schema.Attribute.DateTime & Schema.Attribute.Private;
    version: Schema.Attribute.Integer &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<0>;
  };
}

export interface ApiUniqueCouponPoolUniqueCouponPool
  extends Struct.CollectionTypeSchema {
  collectionName: 'unique_coupon_pools';
  info: {
    description: 'Pools of unique coupon codes that can be redeemed one-at-a-time';
    displayName: 'Unique Coupon Pool';
    pluralName: 'unique-coupon-pools';
    singularName: 'unique-coupon-pool';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    codes: Schema.Attribute.Relation<
      'oneToMany',
      'api::unique-code.unique-code'
    > &
      Schema.Attribute.Private;
    coupons: Schema.Attribute.Relation<'oneToMany', 'api::coupon.coupon'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deals: Schema.Attribute.Relation<'oneToMany', 'api::deal.deal'>;
    exhaustedAt: Schema.Attribute.DateTime;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::unique-coupon-pool.unique-coupon-pool'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    totalCodes: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    usedCodes: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
  };
}

export interface PluginContentReleasesRelease
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_releases';
  info: {
    displayName: 'Release';
    pluralName: 'releases';
    singularName: 'release';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    actions: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release-action'
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    releasedAt: Schema.Attribute.DateTime;
    scheduledAt: Schema.Attribute.DateTime;
    status: Schema.Attribute.Enumeration<
      ['ready', 'blocked', 'failed', 'done', 'empty']
    > &
      Schema.Attribute.Required;
    timezone: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginContentReleasesReleaseAction
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_release_actions';
  info: {
    displayName: 'Release Action';
    pluralName: 'release-actions';
    singularName: 'release-action';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentType: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    entryDocumentId: Schema.Attribute.String;
    isEntryValid: Schema.Attribute.Boolean;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release-action'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    release: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::content-releases.release'
    >;
    type: Schema.Attribute.Enumeration<['publish', 'unpublish']> &
      Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginI18NLocale extends Struct.CollectionTypeSchema {
  collectionName: 'i18n_locale';
  info: {
    collectionName: 'locales';
    description: '';
    displayName: 'Locale';
    pluralName: 'locales';
    singularName: 'locale';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String & Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::i18n.locale'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.SetMinMax<
        {
          max: 50;
          min: 1;
        },
        number
      >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflow
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows';
  info: {
    description: '';
    displayName: 'Workflow';
    name: 'Workflow';
    pluralName: 'workflows';
    singularName: 'workflow';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentTypes: Schema.Attribute.JSON &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'[]'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    stageRequiredToPublish: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::review-workflows.workflow-stage'
    >;
    stages: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow-stage'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflowStage
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows_stages';
  info: {
    description: '';
    displayName: 'Stages';
    name: 'Workflow Stage';
    pluralName: 'workflow-stages';
    singularName: 'workflow-stage';
  };
  options: {
    draftAndPublish: false;
    version: '1.1.0';
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    color: Schema.Attribute.String & Schema.Attribute.DefaultTo<'#4945FF'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow-stage'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    permissions: Schema.Attribute.Relation<'manyToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    workflow: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::review-workflows.workflow'
    >;
  };
}

export interface PluginUploadFile extends Struct.CollectionTypeSchema {
  collectionName: 'files';
  info: {
    description: '';
    displayName: 'File';
    pluralName: 'files';
    singularName: 'file';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    alternativeText: Schema.Attribute.Text;
    backgroundColour: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 7;
        minLength: 7;
      }>;
    backgroundRemovalSourceHash: Schema.Attribute.String &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 64;
      }>;
    backgroundRemovalVersion: Schema.Attribute.String &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    backgroundRemovedAt: Schema.Attribute.DateTime & Schema.Attribute.Private;
    caption: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    ext: Schema.Attribute.String;
    focalPoint: Schema.Attribute.JSON;
    folder: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'> &
      Schema.Attribute.Private;
    folderPath: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    formats: Schema.Attribute.JSON;
    hash: Schema.Attribute.String & Schema.Attribute.Required;
    height: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::upload.file'
    > &
      Schema.Attribute.Private;
    mime: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    previewUrl: Schema.Attribute.Text;
    provider: Schema.Attribute.String & Schema.Attribute.Required;
    provider_metadata: Schema.Attribute.JSON;
    publishedAt: Schema.Attribute.DateTime;
    related: Schema.Attribute.Relation<'morphToMany'>;
    size: Schema.Attribute.Decimal & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    url: Schema.Attribute.Text & Schema.Attribute.Required;
    width: Schema.Attribute.Integer;
  };
}

export interface PluginUploadFolder extends Struct.CollectionTypeSchema {
  collectionName: 'upload_folders';
  info: {
    displayName: 'Folder';
    pluralName: 'folders';
    singularName: 'folder';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    children: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.folder'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    files: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.file'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::upload.folder'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    parent: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'>;
    path: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    pathId: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsPermission
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.role'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsRole
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.role'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.String & Schema.Attribute.Unique;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.user'
    >;
  };
}

export interface PluginUsersPermissionsUser
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'user';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
    timestamps: true;
  };
  attributes: {
    blocked: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    confirmationToken: Schema.Attribute.String & Schema.Attribute.Private;
    confirmed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.user'
    > &
      Schema.Attribute.Private;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    provider: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    role: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.role'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    username: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ContentTypeSchemas {
      'admin::api-token': AdminApiToken;
      'admin::api-token-permission': AdminApiTokenPermission;
      'admin::permission': AdminPermission;
      'admin::role': AdminRole;
      'admin::session': AdminSession;
      'admin::transfer-token': AdminTransferToken;
      'admin::transfer-token-permission': AdminTransferTokenPermission;
      'admin::user': AdminUser;
      'api::about-page.about-page': ApiAboutPageAboutPage;
      'api::affiliate-disclosure-page.affiliate-disclosure-page': ApiAffiliateDisclosurePageAffiliateDisclosurePage;
      'api::bank.bank': ApiBankBank;
      'api::brand.brand': ApiBrandBrand;
      'api::career-page.career-page': ApiCareerPageCareerPage;
      'api::category.category': ApiCategoryCategory;
      'api::contact-page.contact-page': ApiContactPageContactPage;
      'api::coupon.coupon': ApiCouponCoupon;
      'api::culture-page.culture-page': ApiCulturePageCulturePage;
      'api::deal-of-the-day-page.deal-of-the-day-page': ApiDealOfTheDayPageDealOfTheDayPage;
      'api::deal.deal': ApiDealDeal;
      'api::error-page.error-page': ApiErrorPageErrorPage;
      'api::faq-page.faq-page': ApiFaqPageFaqPage;
      'api::footer.footer': ApiFooterFooter;
      'api::global.global': ApiGlobalGlobal;
      'api::homepage.homepage': ApiHomepageHomepage;
      'api::job.job': ApiJobJob;
      'api::menu.menu': ApiMenuMenu;
      'api::partner-with-us-page.partner-with-us-page': ApiPartnerWithUsPagePartnerWithUsPage;
      'api::privacy-policy-page.privacy-policy-page': ApiPrivacyPolicyPagePrivacyPolicyPage;
      'api::redirect.redirect': ApiRedirectRedirect;
      'api::store.store': ApiStoreStore;
      'api::terms-and-conditions-page.terms-and-conditions-page': ApiTermsAndConditionsPageTermsAndConditionsPage;
      'api::testimonials-page.testimonials-page': ApiTestimonialsPageTestimonialsPage;
      'api::unique-code.unique-code': ApiUniqueCodeUniqueCode;
      'api::unique-coupon-pool.unique-coupon-pool': ApiUniqueCouponPoolUniqueCouponPool;
      'plugin::content-releases.release': PluginContentReleasesRelease;
      'plugin::content-releases.release-action': PluginContentReleasesReleaseAction;
      'plugin::i18n.locale': PluginI18NLocale;
      'plugin::review-workflows.workflow': PluginReviewWorkflowsWorkflow;
      'plugin::review-workflows.workflow-stage': PluginReviewWorkflowsWorkflowStage;
      'plugin::upload.file': PluginUploadFile;
      'plugin::upload.folder': PluginUploadFolder;
      'plugin::users-permissions.permission': PluginUsersPermissionsPermission;
      'plugin::users-permissions.role': PluginUsersPermissionsRole;
      'plugin::users-permissions.user': PluginUsersPermissionsUser;
    }
  }
}
