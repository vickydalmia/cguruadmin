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
    mobileSubheading: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
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
    highlights: Schema.Attribute.Component<'career.hero-highlight', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 3;
        },
        number
      >;
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

export interface CareerHeroHighlight extends Struct.ComponentSchema {
  collectionName: 'components_career_hero_highlights';
  info: {
    displayName: 'Career Hero Highlight';
    icon: 'ticket';
  };
  attributes: {
    openingLabel: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    style: Schema.Attribute.Enumeration<['mint', 'paper', 'navy']> &
      Schema.Attribute.DefaultTo<'mint'>;
    teamLabel: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 70;
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

export interface ContactContactMethod extends Struct.ComponentSchema {
  collectionName: 'components_contact_contact_methods';
  info: {
    description: 'One address, email, phone or website item shown above the Contact form.';
    displayName: 'Contact Method';
    icon: 'envelop';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    icon: Schema.Attribute.Enumeration<
      ['location', 'email', 'phone', 'website']
    > &
      Schema.Attribute.DefaultTo<'email'>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    url: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 300;
      }>;
    value: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
  };
}

export interface ContactForm extends Struct.ComponentSchema {
  collectionName: 'components_contact_forms';
  info: {
    description: 'Labels, placeholders, options and response messages for the Contact form.';
    displayName: 'Contact Form';
    icon: 'envelop';
  };
  attributes: {
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
        maxLength: 240;
      }>;
    heading: Schema.Attribute.String &
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
    nameLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    namePlaceholder: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    pendingLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    submitLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    successMessage: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 240;
      }>;
    topicLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    topicPlaceholder: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    topics: Schema.Attribute.Component<'contact.topic', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 12;
        },
        number
      >;
  };
}

export interface ContactHero extends Struct.ComponentSchema {
  collectionName: 'components_contact_heroes';
  info: {
    description: 'Hero copy and background image for the public Contact page.';
    displayName: 'Contact Hero';
    icon: 'picture';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 420;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    image: Schema.Attribute.Media<'images'>;
    imageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
  };
}

export interface ContactTopic extends Struct.ComponentSchema {
  collectionName: 'components_contact_topics';
  info: {
    description: 'One selectable reason in the Contact form.';
    displayName: 'Contact Topic';
    icon: 'bulletList';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
  };
}

export interface CultureGallery extends Struct.ComponentSchema {
  collectionName: 'components_culture_galleries';
  info: {
    description: "Filterable team-photo grid. Every photo is rendered into the HTML; the tabs and Load more only toggle visibility, so nothing is hidden from search engines. Each photo's Category Id must match a category's Category Id for it to appear under that tab.";
    displayName: 'Culture Gallery Band';
    icon: 'picture';
  };
  attributes: {
    allLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 24;
      }> &
      Schema.Attribute.DefaultTo<'All'>;
    categories: Schema.Attribute.Component<'culture.gallery-category', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 10;
        },
        number
      >;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
    loadMoreLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 24;
      }> &
      Schema.Attribute.DefaultTo<'Load more'>;
    photos: Schema.Attribute.Component<'culture.gallery-photo', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 60;
        },
        number
      >;
  };
}

export interface CultureGalleryCategory extends Struct.ComponentSchema {
  collectionName: 'components_culture_gallery_categories';
  info: {
    description: 'One filter tab above the photo grid. Category Id must match the Category Id typed on each photo, and a tab that no photo uses is dropped rather than rendered as a tab that filters to nothing. The field is named categoryId rather than id because `id` is reserved by Strapi and a model cannot declare it.';
    displayName: 'Culture Gallery Category';
    icon: 'filter';
  };
  attributes: {
    categoryId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
  };
}

export interface CultureGalleryPhoto extends Struct.ComponentSchema {
  collectionName: 'components_culture_gallery_photos';
  info: {
    description: 'One photo in the life-at-CouponzGuru grid. Upload the camera original into the dedicated Culture Gallery Media Library folder before selecting it here to use the high-quality photographic profile. Category Id must match one of the tabs above; leave it blank and the photo shows only under "All".';
    displayName: 'Culture Gallery Photo';
    icon: 'picture';
  };
  attributes: {
    alt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    categoryId: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    image: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
  };
}

export interface CultureHero extends Struct.ComponentSchema {
  collectionName: 'components_culture_heroes';
  info: {
    description: "Top-of-page hero: glass eyebrow pill, headline, a teal-ruled intro line and a primary CTA over a full-bleed photograph. This image is the page's LCP element \u2014 upload the largest original available; the site generates the responsive ladder.";
    displayName: 'Culture Hero';
    icon: 'picture';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    ctaUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
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
    image: Schema.Attribute.Media<'images'>;
    imageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
  };
}

export interface CultureJourney extends Struct.ComponentSchema {
  collectionName: 'components_culture_journeys';
  info: {
    description: 'The "our journey" timeline. Milestones render oldest-to-newest in the order listed here \u2014 the page does not sort them.';
    displayName: 'Culture Journey Band';
    icon: 'clock';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
    milestones: Schema.Attribute.Component<'culture.milestone', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 12;
        },
        number
      >;
  };
}

export interface CultureMilestone extends Struct.ComponentSchema {
  collectionName: 'components_culture_milestones';
  info: {
    description: 'One dated entry on the culture timeline. `year` is a string so "2011" and copy like "2026 \u2192" both render; the connecting rail between entries is drawn by the component.';
    displayName: 'Culture Milestone';
    icon: 'clock';
  };
  attributes: {
    body: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 240;
      }>;
    iconKey: Schema.Attribute.Enumeration<
      [
        'bolt',
        'verified',
        'refresh',
        'target',
        'building',
        'globe',
        'book',
        'award',
        'dna',
      ]
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'globe'>;
    year: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 12;
      }>;
  };
}

export interface CultureRecruitment extends Struct.ComponentSchema {
  collectionName: 'components_culture_recruitments';
  info: {
    description: 'Closing hiring banner: copy and two CTAs beside a photograph. Untick Enabled to hide the whole banner.';
    displayName: 'Culture Recruitment Banner';
    icon: 'handHeart';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
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
    primaryLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    primaryUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
    secondaryLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    secondaryUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
  };
}

export interface CultureStat extends Struct.ComponentSchema {
  collectionName: 'components_culture_stats';
  info: {
    description: 'One figure in the band under the hero. `value` is a string so "30+", "6" and "Pune" render in the same row. `shortLabel` is what the narrow phone band shows \u2014 "countries served" does not fit a 375px third-column; leave it blank to reuse the full label.';
    displayName: 'Culture Stat';
    icon: 'chartBubble';
  };
  attributes: {
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
    shortLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 20;
      }>;
    value: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 16;
      }>;
  };
}

export interface CultureTestimonial extends Struct.ComponentSchema {
  collectionName: 'components_culture_testimonials';
  info: {
    description: 'One teammate quote. These are staff talking about working here, not customer reviews of a product \u2014 the page deliberately emits no Review structured data for them, so the star row is a visual device only.';
    displayName: 'Culture Testimonial';
    icon: 'quote';
  };
  attributes: {
    avatar: Schema.Attribute.Media<'images'>;
    avatarAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    quote: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 600;
      }>;
    rating: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 5;
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<5>;
    roleTenure: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
  };
}

export interface CultureTestimonials extends Struct.ComponentSchema {
  collectionName: 'components_culture_testimonial_bands';
  info: {
    description: 'The dark "from the team" band. Untick Enabled to hide it; an empty item list falls back to the committed design copy.';
    displayName: 'Culture Testimonials Band';
    icon: 'quote';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
    items: Schema.Attribute.Component<'culture.testimonial', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 12;
        },
        number
      >;
  };
}

export interface CultureValueCard extends Struct.ComponentSchema {
  collectionName: 'components_culture_value_cards';
  info: {
    description: 'Circular icon badge over a title and short body. The icon is picked from a fixed set and rendered as inline SVG \u2014 no media upload, so it costs no extra request.';
    displayName: 'Culture Value Card';
    icon: 'grid';
  };
  attributes: {
    body: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
    iconKey: Schema.Attribute.Enumeration<
      [
        'bolt',
        'verified',
        'refresh',
        'target',
        'building',
        'globe',
        'book',
        'award',
        'dna',
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

export interface CultureValues extends Struct.ComponentSchema {
  collectionName: 'components_culture_values';
  info: {
    description: 'The "our values" band. Untick Enabled to hide the whole band; leaving the card list empty falls back to the committed design copy rather than rendering an empty grid.';
    displayName: 'Culture Values Band';
    icon: 'bulletList';
  };
  attributes: {
    cards: Schema.Attribute.Component<'culture.value-card', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    header: Schema.Attribute.Component<'shared.section-header', false>;
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

export interface DealDayTelegramDealItem extends Struct.ComponentSchema {
  collectionName: 'components_deal_day_telegram_deal_items';
  info: {
    displayName: 'Deal Day Telegram Deal Item';
    icon: 'paperPlane';
  };
  attributes: {
    deal: Schema.Attribute.Relation<'oneToOne', 'api::deal.deal'>;
    linkOverride: Schema.Attribute.String;
    titleOverride: Schema.Attribute.String;
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
    description: Schema.Attribute.Text;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String;
    items: Schema.Attribute.Component<'deal-day.telegram-deal-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 6;
        },
        number
      >;
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

export interface FaqCategory extends Struct.ComponentSchema {
  collectionName: 'components_faq_categories';
  info: {
    description: 'A navigation category and its ordered FAQ items. The category is omitted publicly when disabled or empty.';
    displayName: 'FAQ Category';
    icon: 'folder';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    items: Schema.Attribute.Component<'faq.faq-item', true>;
    mobileLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 50;
      }>;
    navigationLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 50;
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
  };
}

export interface FaqFaqItem extends Struct.ComponentSchema {
  collectionName: 'components_faq_faq_items';
  info: {
    description: 'One complete question and answer rendered in the public FAQ accordion.';
    displayName: 'FAQ Item';
    icon: 'question-circle';
  };
  attributes: {
    answer: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 5000;
      }>;
    question: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 240;
      }>;
  };
}

export interface FaqSupportCta extends Struct.ComponentSchema {
  collectionName: 'components_faq_support_ctas';
  info: {
    description: 'The support card shown beside the FAQ list on desktop and below it on mobile.';
    displayName: 'FAQ Support CTA';
    icon: 'envelop';
  };
  attributes: {
    action: Schema.Attribute.Component<'shared.cta', false>;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 300;
      }>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    mobileActionLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 50;
      }>;
  };
}

export interface FestivalCampaignHero extends Struct.ComponentSchema {
  collectionName: 'components_festival_campaign_heroes';
  info: {
    displayName: 'Festival Campaign Hero';
    icon: 'picture';
  };
  attributes: {
    altText: Schema.Attribute.String & Schema.Attribute.Required;
    image: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
  };
}

export interface FestivalCouponCategoryTab extends Struct.ComponentSchema {
  collectionName: 'components_festival_coupon_category_tabs';
  info: {
    description: 'One of the four category tabs, with an optional campaign-specific image';
    displayName: 'Festival Coupon Category Tab';
    icon: 'grid';
  };
  attributes: {
    category: Schema.Attribute.Relation<'oneToOne', 'api::category.category'>;
    iconOverride: Schema.Attribute.Media<'images'>;
    labelOverride: Schema.Attribute.String;
    offers: Schema.Attribute.Relation<'oneToMany', 'api::coupon.coupon'>;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface FestivalCouponStoreTab extends Struct.ComponentSchema {
  collectionName: 'components_festival_coupon_store_tabs';
  info: {
    displayName: 'Festival Coupon Store Tab';
    icon: 'shoppingCart';
  };
  attributes: {
    labelOverride: Schema.Attribute.String;
    offers: Schema.Attribute.Relation<'oneToMany', 'api::coupon.coupon'>;
    store: Schema.Attribute.Relation<'oneToOne', 'api::store.store'>;
  };
}

export interface FestivalCouponsByCategory extends Struct.ComponentSchema {
  collectionName: 'components_festival_coupons_by_categories';
  info: {
    description: 'Festival-only category section limited to four tabs';
    displayName: 'Festival Coupons By Category';
    icon: 'grid';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Explore By Category'>;
    tabs: Schema.Attribute.Component<'festival.coupon-category-tab', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
          min: 1;
        },
        number
      >;
    viewAllCta: Schema.Attribute.Component<'shared.cta', false>;
  };
}

export interface FestivalCouponsByStore extends Struct.ComponentSchema {
  collectionName: 'components_festival_coupons_by_stores';
  info: {
    displayName: 'Festival Coupons By Store';
    icon: 'shoppingCart';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Explore By Stores'>;
    tabs: Schema.Attribute.Component<'festival.coupon-store-tab', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
  };
}

export interface FestivalPromoStrip extends Struct.ComponentSchema {
  collectionName: 'components_festival_promo_strips';
  info: {
    displayName: 'Festival Promo Strip';
    icon: 'apps';
  };
  attributes: {
    cta: Schema.Attribute.Component<'shared.cta', false>;
    description: Schema.Attribute.Text &
      Schema.Attribute.DefaultTo<'LIMITED TIME ONLY \u26A1'>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'FLASH DEALS'>;
    heading: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'UP TO 70% OFF'>;
  };
}

export interface FestivalSaleCountdown extends Struct.ComponentSchema {
  collectionName: 'components_festival_sale_countdowns';
  info: {
    displayName: 'Festival Sale Countdown';
    icon: 'clock';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    liveCtaHref: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'#all-coupons'>;
    liveCtaLabel: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Offers live'>;
    liveLabel: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Sale ends in'>;
    preSaleCtaHref: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'#top-picks'>;
    preSaleCtaLabel: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Reserve offers now'>;
    preSaleLabel: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Sale starts in'>;
    saleEndAt: Schema.Attribute.DateTime;
    saleStartAt: Schema.Attribute.DateTime;
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
    url: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface FooterGooglePreferredCard extends Struct.ComponentSchema {
  collectionName: 'components_footer_google_preferred_cards';
  info: {
    displayName: 'Google Preferred Card';
    icon: 'search';
  };
  attributes: {
    icon: Schema.Attribute.Media<'images'>;
    label: Schema.Attribute.String & Schema.Attribute.Required;
    url: Schema.Attribute.String & Schema.Attribute.Required;
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

export interface HeaderCouponNotification extends Struct.ComponentSchema {
  collectionName: 'components_header_coupon_notifications';
  info: {
    displayName: 'Coupon';
    icon: 'ticket';
  };
  attributes: {
    coupon: Schema.Attribute.Relation<'oneToOne', 'api::coupon.coupon'>;
    imageOverride: Schema.Attribute.Media<'images'>;
    titleOverride: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
  };
}

export interface HeaderNotification extends Struct.ComponentSchema {
  collectionName: 'components_header_notifications';
  info: {
    displayName: 'Notification';
    icon: 'bell';
  };
  attributes: {
    coupon: Schema.Attribute.Component<'header.coupon-notification', true>;
    productDeal: Schema.Attribute.Component<
      'header.product-deal-notification',
      true
    >;
  };
}

export interface HeaderProductDealNotification extends Struct.ComponentSchema {
  collectionName: 'components_header_product_deal_notifications';
  info: {
    displayName: 'Product Deal';
    icon: 'shoppingCart';
  };
  attributes: {
    imageOverride: Schema.Attribute.Media<'images'>;
    productDeal: Schema.Attribute.Relation<'oneToOne', 'api::deal.deal'>;
    titleOverride: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
  };
}

export interface HeaderSearchSuggestion extends Struct.ComponentSchema {
  collectionName: 'components_header_search_suggestions';
  info: {
    displayName: 'Search Suggestion';
    icon: 'link';
  };
  attributes: {
    text: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    url: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
  };
}

export interface HeaderSearchTopStore extends Struct.ComponentSchema {
  collectionName: 'components_header_search_top_stores';
  info: {
    displayName: 'Search Top Store';
    icon: 'search';
  };
  attributes: {
    store: Schema.Attribute.Relation<'oneToOne', 'api::store.store'> &
      Schema.Attribute.Required;
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
    displayName: 'Hero Offer';
    icon: 'shoppingCart';
  };
  attributes: {
    coupon: Schema.Attribute.Relation<'oneToOne', 'api::coupon.coupon'>;
    deal: Schema.Attribute.Relation<'oneToOne', 'api::deal.deal'>;
    entityType: Schema.Attribute.Enumeration<['deal', 'coupon']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'deal'>;
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
    banks: Schema.Attribute.Relation<'oneToMany', 'api::bank.bank'>;
    brands: Schema.Attribute.Relation<'oneToMany', 'api::brand.brand'>;
    categories: Schema.Attribute.Relation<
      'oneToMany',
      'api::category.category'
    >;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'Popular Searches'>;
    stores: Schema.Attribute.Relation<'oneToMany', 'api::store.store'>;
  };
}

export interface HomePopularStores extends Struct.ComponentSchema {
  collectionName: 'components_home_popular_stores';
  info: {
    displayName: 'Popular Stores & Brands Section';
    icon: 'store';
  };
  attributes: {
    brands: Schema.Attribute.Relation<'oneToMany', 'api::brand.brand'>;
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
    link: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    order: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
  };
}

export interface LegalNavigationItem extends Struct.ComponentSchema {
  collectionName: 'components_legal_navigation_items';
  info: {
    description: "A sidebar link to one section on a legal document page. Target ID must match that section's anchor ID.";
    displayName: 'Legal Navigation Item';
    icon: 'chevronRight';
  };
  attributes: {
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    targetId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
  };
}

export interface LegalSection extends Struct.ComponentSchema {
  collectionName: 'components_legal_sections';
  info: {
    description: 'One ordered section card in a legal document. Rich text supports paragraphs, lists, links, subheadings, and tables.';
    displayName: 'Legal Section';
    icon: 'file';
  };
  attributes: {
    anchorId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    body: Schema.Attribute.RichText & Schema.Attribute.Required;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
  };
}

export interface LegalSupportCta extends Struct.ComponentSchema {
  collectionName: 'components_legal_support_ctas';
  info: {
    description: 'The contact card displayed beside a legal document on desktop and below it on mobile.';
    displayName: 'Legal Support CTA';
    icon: 'envelop';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 300;
      }>;
    emailAddress: Schema.Attribute.Email;
    emailLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
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
    icon: Schema.Attribute.Media<'images'>;
    links: Schema.Attribute.Component<'nav.link', true>;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    url: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
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
    icon: Schema.Attribute.Media<'images'>;
    label: Schema.Attribute.String;
    store: Schema.Attribute.Relation<'oneToOne', 'api::store.store'>;
    url: Schema.Attribute.String;
  };
}

export interface PartnerBanner extends Struct.ComponentSchema {
  collectionName: 'components_partner_banners';
  info: {
    description: 'Integrated marketing callout and in-page CTA.';
    displayName: 'Partner Banner';
    icon: 'cursor';
  };
  attributes: {
    buttonLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    buttonUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 2048;
      }>;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 600;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 140;
      }>;
  };
}

export interface PartnerBenefit extends Struct.ComponentSchema {
  collectionName: 'components_partner_benefits';
  info: {
    displayName: 'Partner Benefit';
    icon: 'star';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 700;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
    icon: Schema.Attribute.Enumeration<['audience', 'campaign', 'results']> &
      Schema.Attribute.DefaultTo<'audience'>;
  };
}

export interface PartnerBenefitsSection extends Struct.ComponentSchema {
  collectionName: 'components_partner_benefits_sections';
  info: {
    description: 'Introductory value proposition and benefit cards.';
    displayName: 'Why Partner Section';
    icon: 'information';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    items: Schema.Attribute.Component<'partner.benefit', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 6;
        },
        number
      >;
  };
}

export interface PartnerCta extends Struct.ComponentSchema {
  collectionName: 'components_partner_ctas';
  info: {
    description: 'Blue gradient call to action above the footer.';
    displayName: 'Partner CTA';
    icon: 'cursor';
  };
  attributes: {
    buttonLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    buttonUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 2048;
      }>;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 140;
      }>;
  };
}

export interface PartnerExposureItem extends Struct.ComponentSchema {
  collectionName: 'components_partner_exposure_items';
  info: {
    displayName: 'Exposure Item';
    icon: 'bulletList';
  };
  attributes: {
    icon: Schema.Attribute.Enumeration<
      ['layout', 'list', 'zap', 'mail', 'share', 'search', 'award', 'users']
    > &
      Schema.Attribute.DefaultTo<'layout'>;
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 140;
      }>;
  };
}

export interface PartnerExposurePillar extends Struct.ComponentSchema {
  collectionName: 'components_partner_exposure_pillars';
  info: {
    displayName: 'Exposure Pillar';
    icon: 'apps';
  };
  attributes: {
    accent: Schema.Attribute.Enumeration<['teal', 'blue']> &
      Schema.Attribute.DefaultTo<'teal'>;
    description: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 140;
      }>;
    items: Schema.Attribute.Component<'partner.exposure-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
  };
}

export interface PartnerExposureSection extends Struct.ComponentSchema {
  collectionName: 'components_partner_exposure_sections';
  info: {
    description: 'Marketing channel pillars and integrated-marketing banner.';
    displayName: 'Exposure Opportunities';
    icon: 'layer';
  };
  attributes: {
    banner: Schema.Attribute.Component<'partner.banner', false>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    pillars: Schema.Attribute.Component<'partner.exposure-pillar', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 3;
        },
        number
      >;
  };
}

export interface PartnerHero extends Struct.ComponentSchema {
  collectionName: 'components_partner_heroes';
  info: {
    description: 'Full-width partner-network hero. Empty fields use the committed Figma fallback.';
    displayName: 'Partner Hero';
    icon: 'picture';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 600;
      }>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 140;
      }>;
    image: Schema.Attribute.Media<'images'>;
    imageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
  };
}

export interface PartnerImpactSection extends Struct.ComponentSchema {
  collectionName: 'components_partner_impact_sections';
  info: {
    description: 'Dark numbers section with up to eight metrics.';
    displayName: 'Impact & Reach';
    icon: 'chartCircle';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
    stats: Schema.Attribute.Component<'partner.stat', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
  };
}

export interface PartnerLogo extends Struct.ComponentSchema {
  collectionName: 'components_partner_logos';
  info: {
    description: 'One trusted-brand logo. A populated logo list replaces the committed fallback list.';
    displayName: 'Partner Logo';
    icon: 'picture';
  };
  attributes: {
    image: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    imageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    row: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 2;
          min: 1;
        },
        number
      > &
      Schema.Attribute.DefaultTo<1>;
    tone: Schema.Attribute.Enumeration<
      ['white', 'blue', 'red', 'black', 'outlined']
    > &
      Schema.Attribute.DefaultTo<'white'>;
  };
}

export interface PartnerPartnershipType extends Struct.ComponentSchema {
  collectionName: 'components_partner_partnership_types';
  info: {
    displayName: 'Partnership Type';
    icon: 'handHeart';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
    number: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 8;
      }>;
  };
}

export interface PartnerPartnershipsSection extends Struct.ComponentSchema {
  collectionName: 'components_partner_partnerships_sections';
  info: {
    description: 'Flexible commercial models and closing note.';
    displayName: 'Partnership Types';
    icon: 'handHeart';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 600;
      }>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    items: Schema.Attribute.Component<'partner.partnership-type', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 6;
        },
        number
      >;
    note: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 1200;
      }>;
  };
}

export interface PartnerStat extends Struct.ComponentSchema {
  collectionName: 'components_partner_stats';
  info: {
    displayName: 'Impact Stat';
    icon: 'chartBubble';
  };
  attributes: {
    label: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    value: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 30;
      }>;
  };
}

export interface PartnerSupportItem extends Struct.ComponentSchema {
  collectionName: 'components_partner_support_items';
  info: {
    displayName: 'Support Feature';
    icon: 'userHeart';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 900;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 140;
      }>;
    icon: Schema.Attribute.Enumeration<['users', 'pen']> &
      Schema.Attribute.DefaultTo<'users'>;
  };
}

export interface PartnerSupportSection extends Struct.ComponentSchema {
  collectionName: 'components_partner_support_sections';
  info: {
    description: 'Support promise, trust badge and service cards.';
    displayName: 'Dedicated Support';
    icon: 'userHeart';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    items: Schema.Attribute.Component<'partner.support-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
        },
        number
      >;
    taglineDescription: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    taglineHeading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    trustBadge: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
  };
}

export interface PartnerTrustedSection extends Struct.ComponentSchema {
  collectionName: 'components_partner_trusted_sections';
  info: {
    description: 'Logo marquee on desktop and six-logo grid on mobile.';
    displayName: 'Trusted Relationships';
    icon: 'grid';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    logos: Schema.Attribute.Component<'partner.logo', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 24;
        },
        number
      >;
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

export interface SharedEntityDealPageSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_entity_deal_page_seos';
  info: {
    description: 'SEO overrides and indexing opt-in for the generated entity Product Deal page.';
    displayName: 'Entity Deal Page SEO';
    icon: 'search';
  };
  attributes: {
    canonicalUrl: Schema.Attribute.String;
    indexingEnabled: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    metaDescription: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 170;
      }>;
    metaTitle: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 70;
      }>;
    ogDescription: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
    ogImage: Schema.Attribute.Media<'images'>;
    ogImageAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 125;
      }>;
    ogTitle: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 95;
      }>;
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

export interface TestimonialFaqSection extends Struct.ComponentSchema {
  collectionName: 'components_testimonial_faq_sections';
  info: {
    description: 'Compact FAQ accordion shown above the site footer.';
    displayName: 'Testimonials FAQ Section';
    icon: 'question-circle';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    items: Schema.Attribute.Component<'faq.faq-item', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 8;
        },
        number
      >;
  };
}

export interface TestimonialFeaturedSection extends Struct.ComponentSchema {
  collectionName: 'components_testimonial_featured_sections';
  info: {
    description: 'The highlighted quote carousel at the top of the page. Each slide supplies its own quote, author and portrait \u2014 the portrait is what appears in the selector row beneath the card, so a slide with no portrait falls back to the committed one. Add two or more slides to make the row interactive; with a single slide the selectors are hidden.';
    displayName: 'Featured Testimonial Section';
    icon: 'star';
  };
  attributes: {
    autoplaySeconds: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 60;
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<7>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    initialIndex: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 9;
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    slides: Schema.Attribute.Component<'testimonial.testimonial', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 10;
        },
        number
      >;
  };
}

export interface TestimonialHero extends Struct.ComponentSchema {
  collectionName: 'components_testimonial_heroes';
  info: {
    description: 'Intro badge, main heading and supporting copy above the testimonial sections.';
    displayName: 'Testimonials Hero';
    icon: 'quote';
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
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 140;
      }>;
  };
}

export interface TestimonialPartnerCta extends Struct.ComponentSchema {
  collectionName: 'components_testimonial_partner_ctas';
  info: {
    description: 'Blue gradient partnership call to action below the testimonial cards.';
    displayName: 'Partner CTA';
    icon: 'cursor';
  };
  attributes: {
    buttonLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    buttonUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 2048;
      }>;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 320;
      }>;
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    eyebrow: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 140;
      }>;
  };
}

export interface TestimonialPartnersSection extends Struct.ComponentSchema {
  collectionName: 'components_testimonial_partner_sections';
  info: {
    description: 'Heading, ordered quote cards and mobile pagination count.';
    displayName: 'Partner Testimonials Section';
    icon: 'grid';
  };
  attributes: {
    enabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    heading: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    paginationCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 10;
          min: 1;
        },
        number
      > &
      Schema.Attribute.DefaultTo<6>;
    testimonials: Schema.Attribute.Component<'testimonial.testimonial', true> &
      Schema.Attribute.SetMinMax<
        {
          max: 18;
        },
        number
      >;
  };
}

export interface TestimonialTestimonial extends Struct.ComponentSchema {
  collectionName: 'components_testimonial_testimonials';
  info: {
    description: 'One partner quote and its author details.';
    displayName: 'Testimonial';
    icon: 'quote';
  };
  attributes: {
    authorName: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    authorRole: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160;
      }>;
    avatar: Schema.Attribute.Media<'images'>;
    avatarAlt: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 180;
      }>;
    avatarRing: Schema.Attribute.Enumeration<['yellow', 'navy', 'teal']> &
      Schema.Attribute.DefaultTo<'yellow'>;
    quote: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 1500;
      }>;
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
      'career.hero-highlight': CareerHeroHighlight;
      'career.job-detail-copy': CareerJobDetailCopy;
      'career.jobs-section': CareerJobsSection;
      'career.life': CareerLife;
      'career.value-card': CareerValueCard;
      'contact.contact-method': ContactContactMethod;
      'contact.form': ContactForm;
      'contact.hero': ContactHero;
      'contact.topic': ContactTopic;
      'culture.gallery': CultureGallery;
      'culture.gallery-category': CultureGalleryCategory;
      'culture.gallery-photo': CultureGalleryPhoto;
      'culture.hero': CultureHero;
      'culture.journey': CultureJourney;
      'culture.milestone': CultureMilestone;
      'culture.recruitment': CultureRecruitment;
      'culture.stat': CultureStat;
      'culture.testimonial': CultureTestimonial;
      'culture.testimonials': CultureTestimonials;
      'culture.value-card': CultureValueCard;
      'culture.values': CultureValues;
      'deal-day.deals-by-store': DealDayDealsByStore;
      'deal-day.section-heading': DealDaySectionHeading;
      'deal-day.store-tab': DealDayStoreTab;
      'deal-day.telegram-deal-item': DealDayTelegramDealItem;
      'deal-day.telegram-deals': DealDayTelegramDeals;
      'error-page.explore': ErrorPageExplore;
      'error-page.hero': ErrorPageHero;
      'error-page.link-card': ErrorPageLinkCard;
      'error-page.trust-banner': ErrorPageTrustBanner;
      'faq.category': FaqCategory;
      'faq.faq-item': FaqFaqItem;
      'faq.support-cta': FaqSupportCta;
      'festival.campaign-hero': FestivalCampaignHero;
      'festival.coupon-category-tab': FestivalCouponCategoryTab;
      'festival.coupon-store-tab': FestivalCouponStoreTab;
      'festival.coupons-by-category': FestivalCouponsByCategory;
      'festival.coupons-by-store': FestivalCouponsByStore;
      'festival.promo-strip': FestivalPromoStrip;
      'festival.sale-countdown': FestivalSaleCountdown;
      'footer.country': FooterCountry;
      'footer.google-preferred-card': FooterGooglePreferredCard;
      'footer.link-section': FooterLinkSection;
      'footer.partner-card': FooterPartnerCard;
      'footer.social-link': FooterSocialLink;
      'header.coupon-notification': HeaderCouponNotification;
      'header.notification': HeaderNotification;
      'header.product-deal-notification': HeaderProductDealNotification;
      'header.search-suggestion': HeaderSearchSuggestion;
      'header.search-top-store': HeaderSearchTopStore;
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
      'legal.navigation-item': LegalNavigationItem;
      'legal.section': LegalSection;
      'legal.support-cta': LegalSupportCta;
      'nav.category-section': NavCategorySection;
      'nav.link': NavLink;
      'partner.banner': PartnerBanner;
      'partner.benefit': PartnerBenefit;
      'partner.benefits-section': PartnerBenefitsSection;
      'partner.cta': PartnerCta;
      'partner.exposure-item': PartnerExposureItem;
      'partner.exposure-pillar': PartnerExposurePillar;
      'partner.exposure-section': PartnerExposureSection;
      'partner.hero': PartnerHero;
      'partner.impact-section': PartnerImpactSection;
      'partner.logo': PartnerLogo;
      'partner.partnership-type': PartnerPartnershipType;
      'partner.partnerships-section': PartnerPartnershipsSection;
      'partner.stat': PartnerStat;
      'partner.support-item': PartnerSupportItem;
      'partner.support-section': PartnerSupportSection;
      'partner.trusted-section': PartnerTrustedSection;
      'shared.breadcrumb-item': SharedBreadcrumbItem;
      'shared.cta': SharedCta;
      'shared.entity-deal-page-seo': SharedEntityDealPageSeo;
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
      'testimonial.faq-section': TestimonialFaqSection;
      'testimonial.featured-section': TestimonialFeaturedSection;
      'testimonial.hero': TestimonialHero;
      'testimonial.partner-cta': TestimonialPartnerCta;
      'testimonial.partners-section': TestimonialPartnersSection;
      'testimonial.testimonial': TestimonialTestimonial;
    }
  }
}
