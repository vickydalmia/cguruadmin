import type { Core } from '@strapi/strapi';
import { DOTD_SECTION_CAPS as SECTION_CAPS } from '../../../constants/deal-of-the-day-sections';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import {
  backfillDeals,
  cap,
  categoryRef,
  dealRef,
  isActionableProductDeal,
  isLiveOffer,
  latestActionableCatalog,
  PUBLISHED_OFFER_FILTER,
  sanitizeOutput,
  storeRef,
} from '../../../utils/offer-visibility';

// Aggregate endpoint for the deal-of-the-day category landing page: one
// request returns every curated section fully populated, mirroring the
// homepage-full contract. Deal-schema records only — Coupon records never
// enter any section on this page.

// Fixed-size API lists keep CMS-authored buffers over what the site renders.
// Smart Saving Stack is the exception: every curated Deal is returned in the
// editor's order for its unlimited carousel.

import { DOTD_POPULATE } from './deal-of-the-day-populate';
import {
  attachStablePublicOfferIdsForRequest,
  requestedOfferTargetLocale,
} from '../../coupon/services/public-offer-ids';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import {
  attachDealCounts,
  capCuratedLists,
  dropDeadOffers,
  fillDerivedSections,
  sectionActive,
} from './deal-of-the-day-transforms';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async dealOfTheDayFull(ctx) {
    // The single type has draftAndPublish disabled — the entry is live once
    // saved; findFirst returns null until an admin creates it. Like the
    // homepage, the storefront asks for the request language via ?locale=
    // so an /ar/ render gets the translated row, not English copy.
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const page = await strapi
      .documents('api::deal-of-the-day-page.deal-of-the-day-page')
      .findFirst({ locale, populate: DOTD_POPULATE as any });

    if (!page) {
      return ctx.notFound('Deal of the day page not found');
    }

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      'api::deal-of-the-day-page.deal-of-the-day-page',
      page,
    );
    // Capture relation presence before dead/unusable Deals are removed. An
    // explicit selection remains authoritative even if every selected Deal
    // later expires; silently switching to fallback would violate CMS intent.
    const curatedSelections = {
      categoryTabs: new Set<any>(
        (sanitized?.dealsByCategory?.tabs ?? []).filter(
          (tab: any) => Array.isArray(tab?.deals) && tab.deals.length > 0,
        ),
      ),
      storeTabs: new Set<any>(
        (sanitized?.dealsByStore?.tabs ?? []).filter(
          (tab: any) => Array.isArray(tab?.deals) && tab.deals.length > 0,
        ),
      ),
      allDeals:
        Array.isArray(sanitized?.allDeals?.deals) &&
        sanitized.allDeals.deals.length > 0,
    };
    dropDeadOffers(sanitized);
    await fillDerivedSections(strapi, ctx, sanitized, curatedSelections);
    capCuratedLists(sanitized);
    await attachDealCounts(strapi, sanitized);
    // Decorate Deal benefit labels and attach computed pricing content.
    arrayizeOfferText(sanitized);
    // Resolves each Deal's Checkout Merchant to its festive offer.
    await attachFestiveOffers(strapi, sanitized);
    await attachStablePublicOfferIdsForRequest(strapi, ctx, sanitized, ['deal']);

    return ctx.send({ data: sanitized });
  },
});
