import type { Schema, Struct } from '@strapi/strapi';

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

export interface SharedFaqItem extends Struct.ComponentSchema {
  collectionName: 'components_shared_faq_items';
  info: {
    displayName: 'FAQ Item';
    icon: 'question-circle';
  };
  attributes: {
    answer: Schema.Attribute.Text & Schema.Attribute.Required;
    question: Schema.Attribute.String & Schema.Attribute.Required;
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

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'homepage.slider-slide': HomepageSliderSlide;
      'shared.faq-item': SharedFaqItem;
      'shared.seo': SharedSeo;
    }
  }
}
