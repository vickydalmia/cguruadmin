import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from '../../../utils/offer-visibility';

const DEFAULT_ERROR_PAGE = {
  title: 'Error Page',
  hero: {
    ticketTitle: 'OOPS!',
    ticketDescription: 'This page has vanished like a deal after midnight',
    heading: 'Page not found',
    description:
      "Sorry, we couldn't find the page you're looking for. It might have been moved or doesn't exist.",
    searchPlaceholder: 'Search for deals, stores & coupons',
    searchLabel: 'Search CouponzGuru',
    searchButtonLabel: 'Search',
    actionsLabel: 'Error page actions',
    homeCta: { label: 'Back to Home', url: '/' },
    dealsCta: { label: "Today’s Deals", url: '/deal-of-the-day/' },
  },
  explore: {
    eyebrow: 'while you’re here',
    heading: 'Explore What’s Working Right Now',
    couponsCard: {
      title: "Today’s Coupons",
      description: 'Browse verified deals updated daily',
      ctaLabel: 'View Deals',
      url: '/deal-of-the-day/',
    },
    storesCard: {
      title: 'Top Stores',
      mobileTitle: 'Global Exposure',
      description: 'Flipkart, Amazon, Myntra & 5,000+ more',
      ctaLabel: 'View Deals',
      url: '/stores/',
    },
    travelCard: {
      title: 'Travel Deals',
      description: 'MakeMyTrip, Yatra and Flight offers',
      ctaLabel: 'View Deals',
      url: '/categories/travel/',
    },
    electronicsCard: {
      title: 'Electronics',
      description: 'Phone, laptops and gadget discount',
      ctaLabel: 'View Deals',
      url: '/categories/electronics/',
    },
  },
  trustBanner: {
    heading: '100% Verified Coupons - Free to Use',
    description: 'Every deal on CouponzGuru is manually tested before it goes live.',
    ctaLabel: 'Explore Deals',
    url: '/deal-of-the-day/',
  },
} as const;

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

function safeUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const candidate = value.trim();
  if (/^\/(?!\/)/.test(candidate)) return candidate;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {
    // Invalid and executable schemes use the controlled fallback.
  }
  return fallback;
}

function card(value: any, fallback: any) {
  return {
    title: text(value?.title, fallback.title),
    mobileTitle:
      typeof value?.mobileTitle === 'string' && value.mobileTitle.trim()
        ? value.mobileTitle.trim()
        : fallback.mobileTitle,
    description: text(value?.description, fallback.description),
    ctaLabel: text(value?.ctaLabel, fallback.ctaLabel),
    url: safeUrl(value?.url, fallback.url),
  };
}

function mapErrorPage(value: any) {
  const hero = value?.hero;
  const explore = value?.explore;
  const trust = value?.trustBanner;
  const defaults = DEFAULT_ERROR_PAGE;
  return {
    title: text(value?.title, defaults.title),
    hero: {
      ticketTitle: 'OOPS!',
      ticketDescription: text(hero?.ticketDescription, defaults.hero.ticketDescription),
      heading: text(hero?.heading, defaults.hero.heading),
      description: text(hero?.description, defaults.hero.description),
      searchPlaceholder: text(hero?.searchPlaceholder, defaults.hero.searchPlaceholder),
      searchLabel: text(hero?.searchLabel, defaults.hero.searchLabel),
      searchButtonLabel: text(hero?.searchButtonLabel, defaults.hero.searchButtonLabel),
      actionsLabel: text(hero?.actionsLabel, defaults.hero.actionsLabel),
      homeCta: {
        label: text(hero?.homeCta?.label, defaults.hero.homeCta.label),
        url: safeUrl(hero?.homeCta?.url, defaults.hero.homeCta.url),
      },
      dealsCta: {
        label: text(hero?.dealsCta?.label, defaults.hero.dealsCta.label),
        url: safeUrl(hero?.dealsCta?.url, defaults.hero.dealsCta.url),
      },
    },
    explore: {
      eyebrow: text(explore?.eyebrow, defaults.explore.eyebrow),
      heading: text(explore?.heading, defaults.explore.heading),
      couponsCard: card(explore?.couponsCard, defaults.explore.couponsCard),
      storesCard: card(explore?.storesCard, defaults.explore.storesCard),
      travelCard: card(explore?.travelCard, defaults.explore.travelCard),
      electronicsCard: card(explore?.electronicsCard, defaults.explore.electronicsCard),
    },
    trustBanner: {
      heading: text(trust?.heading, defaults.trustBanner.heading),
      description: text(trust?.description, defaults.trustBanner.description),
      ctaLabel: text(trust?.ctaLabel, defaults.trustBanner.ctaLabel),
      url: safeUrl(trust?.url, defaults.trustBanner.url),
    },
  };
}

const ERROR_PAGE_POPULATE = {
  hero: { populate: { homeCta: true, dealsCta: true } },
  explore: {
    populate: {
      couponsCard: true,
      storesCard: true,
      travelCard: true,
      electronicsCard: true,
    },
  },
  trustBanner: true,
} as const;

export { DEFAULT_ERROR_PAGE, mapErrorPage, safeUrl };

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async errorPageFull(ctx: any) {
    const document = await strapi
      .documents('api::error-page.error-page' as any)
      .findFirst({ populate: ERROR_PAGE_POPULATE as any });
    const sanitized = document
      ? await sanitizeOutput(strapi, ctx, 'api::error-page.error-page', document)
      : null;
    return ctx.send({ data: mapErrorPage(sanitized) });
  },
});
