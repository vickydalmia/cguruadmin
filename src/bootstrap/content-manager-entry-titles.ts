// Content-manager ENTRY TITLES, pinned on every boot (config-as-code): the
// collapsed-row label field per repeatable component, and the edit-view
// header field per single type. One of the five content-manager view-config
// modules split out of the old bootstrap/content-manager-layouts.ts.
import type { Core } from '@strapi/strapi';

// Content Manager "Entry title" per component — the text field shown as the
// collapsed label of each repeatable entry (e.g. hero banners show altText
// instead of the link URL). Strapi has no schema.json knob for this; it lives
// in the DB config store, so pin it here (config-as-code, survives DB wipes).
const COMPONENT_ENTRY_TITLES: Record<string, string> = {
  'homepage.slider-slide': 'altText',
  // NOTE: relations are NOT usable here — server validation accepts them but
  // the 5.39 admin edit form crashes rendering `{connect, disconnect}` state
  // as the row label. Text fields only; the *_Override fields render blank
  // when unset (the related deal/coupon supplies the real title at runtime).
  'home.hero-product': 'titleOverride',
  'home.top-offer-item': 'offerTextOverride',
  'home.exclusive-item': 'titleOverride',
  'home.coupon-card-item': 'titleOverride',
  'home.bank-offer-item': 'subtitle',
  'home.explore-tab': 'labelOverride',
  'home.explore-offer-tab': 'labelOverride',
  'home.step': 'title',
  'home.why-feature': 'label',
  'home.top-offers': 'heading',
  'home.popular-stores': 'heading',
  'home.deal-list': 'heading',
  'home.cg-exclusive': 'heading',
  'home.explore-deals': 'heading',
  'home.explore-offers': 'heading',
  'home.offer-list': 'heading',
  'home.newly-added': 'heading',
  'home.bank-offers': 'heading',
  'home.how-it-works': 'heading',
  'home.faq-block': 'heading',
  'home.popular-searches': 'heading',
  'home.latest-insights': 'heading',
  'deal-day.deals-by-store': 'heading',
  'deal-day.store-tab': 'labelOverride',
  'deal-day.telegram-deals': 'heading',
  'deal-day.telegram-deal-item': 'titleOverride',
  'deal-day.section-heading': 'heading',
  'festival.coupon-category-tab': 'labelOverride',
  'festival.coupon-store-tab': 'labelOverride',
  'shared.cta': 'label',
  'shared.telegram-cta': 'heading',
  'shared.newsletter': 'heading',
  'shared.section-header': 'heading',
  'shared.paragraph': 'body',
  'shared.icon-card': 'title',
  'shared.stat': 'label',
  // Year over title: a collapsed timeline reads as 2011 / 2014 / 2018, which
  // is what an editor scans for when reordering milestones.
  'shared.milestone': 'year',
  'shared.logo-item': 'name',
  'shared.breadcrumb-item': 'label',
  'about.hero': 'heading',
  'about.founder': 'name',
  'career.hero': 'heading',
  'career.benefit-card': 'title',
  'career.value-card': 'title',
  'career.jobs-section': 'heading',
  'career.life': 'imageAlt',
  'career.job-detail-copy': 'formHeading',
  'contact.hero': 'heading',
  'contact.contact-method': 'title',
  'contact.topic': 'label',
  'contact.form': 'heading',
  'faq.category': 'title',
  'faq.faq-item': 'question',
  'faq.support-cta': 'heading',
  'error-page.hero': 'heading',
  'error-page.link-card': 'title',
  'error-page.explore': 'heading',
  'error-page.trust-banner': 'heading',
  'nav.link': 'label',
  'nav.category-section': 'title',
  'footer.link-section': 'title',
  'footer.social-link': 'platform',
  'footer.country': 'name',
};

export async function ensureComponentEntryTitles(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('components');
  if (!service) return;

  for (const [uid, mainField] of Object.entries(COMPONENT_ENTRY_TITLES)) {
    try {
      const component = service.findComponent(uid);
      if (!component) continue;
      if (!strapi.components[uid as any]?.attributes?.[mainField]) {
        strapi.log.warn(`[content-manager] ${uid} has no field "${mainField}" — entry title skipped`);
        continue;
      }

      const config = await service.findConfiguration(component);
      if (config?.settings?.mainField === mainField) continue;

      await service.updateConfiguration(component, {
        ...config,
        settings: { ...config.settings, mainField },
      });
      strapi.log.info(`[content-manager] entry title for ${uid} → ${mainField}`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] failed to set entry title for ${uid}: ${err?.message ?? err}`
      );
    }
  }
}

// Single types' edit-view headers show their mainField — pin it to the
// `title` attribute ("Homepage"/"Menu"/"Footer") instead of opaque IDs.
const SINGLE_TYPE_ENTRY_TITLES = [
  'api::homepage.homepage',
  'api::deal-of-the-day-page.deal-of-the-day-page',
  'api::independence-day-sale-page.independence-day-sale-page',
  'api::menu.menu',
  'api::footer.footer',
  'api::global.global',
  'api::error-page.error-page',
  'api::career-page.career-page',
  'api::contact-page.contact-page',
  'api::faq-page.faq-page',
  'api::testimonials-page.testimonials-page',
  'api::partner-with-us-page.partner-with-us-page',
  'api::privacy-policy-page.privacy-policy-page',
  'api::terms-and-conditions-page.terms-and-conditions-page',
  'api::affiliate-disclosure-page.affiliate-disclosure-page',
  'api::culture-page.culture-page',
] as const;

export async function ensureSingleTypeEntryTitles(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const uid of SINGLE_TYPE_ENTRY_TITLES) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType?.attributes?.title) continue;

      const config = await service.findConfiguration(contentType);
      if (config?.settings?.mainField === 'title') continue;

      await service.updateConfiguration(contentType, {
        ...config,
        settings: { ...config.settings, mainField: 'title' },
      });
      strapi.log.info(`[content-manager] entry title for ${uid} → title`);
    } catch (err: any) {
      strapi.log.warn(`[content-manager] entry title for ${uid} failed: ${err?.message ?? err}`);
    }
  }
}
