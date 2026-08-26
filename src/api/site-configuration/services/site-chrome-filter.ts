import type { FeatureReadinessMap } from './feature-readiness';

function live(features: FeatureReadinessMap, key: keyof FeatureReadinessMap) {
  return features[key]?.live === true;
}

function urlAllowed(url: unknown, features: FeatureReadinessMap): boolean {
  if (typeof url !== 'string' || !url.trim().startsWith('/')) return true;
  const path = url.trim().split(/[?#]/, 1)[0];
  const exact: Record<string, keyof FeatureReadinessMap> = {
    '/stores/': 'stores',
    '/brands/': 'brands',
    '/categories/': 'categories',
    '/banks/': 'banks',
    '/about-us/': 'about',
    '/careers/': 'careers',
    '/contact-us/': 'contact',
    '/faqs/': 'faqs',
    '/testimonials/': 'testimonials',
    '/partner-with-us/': 'partnerWithUs',
    '/culture/': 'culture',
    '/privacy-policy/': 'privacyPolicy',
    '/terms-and-conditions/': 'termsAndConditions',
    '/affiliate-disclosure/': 'affiliateDisclosure',
  };
  const key = path ? exact[path] : undefined;
  if (key) return live(features, key);
  if (path?.startsWith('/careers/')) return live(features, 'careers');
  if (path?.startsWith('/deal/')) return live(features, 'productDeals');
  if (path?.startsWith('/coupon/')) return live(features, 'coupons');
  return true;
}

function navLinkAllowed(link: any, features: FeatureReadinessMap): boolean {
  const entity = link?.store ?? link?.category;
  if (entity?.pageTemplate === 'dealTemplate') {
    return live(features, 'dealOfTheDay');
  }
  if (entity?.pageTemplate === 'independenceDayTemplate') {
    return live(features, 'independenceDaySale');
  }
  if (link?.store && !live(features, 'stores')) return false;
  if (link?.category && !live(features, 'categories')) return false;
  return urlAllowed(link?.url, features);
}

export function filterSiteChrome(
  menu: any,
  footer: any,
  features: FeatureReadinessMap,
) {
  if (menu) {
    if (!live(features, 'stores')) {
      menu.topStores = [];
      menu.searchTopStores = [];
    }
    if (!live(features, 'categories')) menu.categorySections = [];
    menu.categorySections = (menu.categorySections ?? [])
      .filter((section: any) => !section?.category || live(features, 'categories'))
      .map((section: any) => ({
        ...section,
        links: (section.links ?? []).filter((link: any) =>
          navLinkAllowed(link, features),
        ),
      }));
    menu.extraItems = (menu.extraItems ?? []).filter((link: any) =>
      navLinkAllowed(link, features),
    );
  }

  if (footer) {
    footer.sections = (footer.sections ?? [])
      .map((section: any) => ({
        ...section,
        links: (section.links ?? []).filter((link: any) =>
          navLinkAllowed(link, features),
        ),
      }))
      .filter((section: any) => section.links.length > 0);
    if (!live(features, 'partnerWithUs')) footer.partnerCard = null;
  }

  return { menu, footer };
}
