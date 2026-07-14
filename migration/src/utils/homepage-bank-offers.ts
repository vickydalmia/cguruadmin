import { HOMEPAGE_SEED_LIMITS } from "./homepage-limits.js";

/** Must match `src/components/home/bank-offers.json` (`items.max`). */
export const MAX_HOMEPAGE_BANK_OFFERS = HOMEPAGE_SEED_LIMITS.bankOffers;

/**
 * Preserve the database ranking while enforcing the repeatable-component
 * cardinality for direct-SQL migrations, which do not pass through Strapi's
 * component validation.
 */
export function limitHomepageBankOffers<T>(rankedOffers: readonly T[]): T[] {
  return rankedOffers.slice(0, MAX_HOMEPAGE_BANK_OFFERS);
}
