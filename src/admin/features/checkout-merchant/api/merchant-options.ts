import type { useFetchClient } from '@strapi/strapi/admin';

import {
  CHECKOUT_MERCHANT_SOURCES,
  checkoutMerchantSource,
  formatCheckoutMerchant,
  type CheckoutMerchantKind,
  type CheckoutMerchantRef,
} from '../../../../constants/checkout-merchant';

/**
 * Data access for the Checkout Merchant dropdown.
 *
 * Kept out of the component so the merge/pagination rules are testable and so
 * the component stays about rendering. Everything here goes through the
 * content-manager's own collection-type endpoint, which means the picker
 * inherits the caller's RBAC: a role that cannot read Brands simply sees no
 * Brand options rather than a broken request.
 */

export type MerchantOption = {
  /** The stored field value, e.g. `store:abc123`. Also the Combobox value. */
  value: string;
  kind: CheckoutMerchantKind;
  /** Editor-facing group label — "Store" / "Brand". */
  kindLabel: string;
  documentId: string;
  name: string;
};

export type MerchantPage = {
  options: MerchantOption[];
  hasMore: boolean;
};

/** One page of results per source, plus whether that source has more. */
export type MerchantSearchResult = {
  /** Stores first, then Brands — the CHECKOUT_MERCHANT_SOURCES order. */
  options: MerchantOption[];
  hasMore: boolean;
};

/**
 * Exactly the `get` that `useFetchClient` returns, borrowed rather than
 * re-declared: it is a four-way OVERLOADED signature, and any hand-written
 * approximation binds to the wrong overload and fails to accept the real
 * client. Type-only import, so nothing from the admin bundle is pulled in at
 * runtime and the tests can pass a two-line double.
 */
type FetchClient = Pick<ReturnType<typeof useFetchClient>, 'get'>;

export const MERCHANT_PAGE_SIZE = 20;

const toOption = (
  source: (typeof CHECKOUT_MERCHANT_SOURCES)[number],
  row: any,
): MerchantOption | null => {
  const documentId = row?.documentId;
  if (typeof documentId !== 'string' || !documentId) return null;
  return {
    value: formatCheckoutMerchant({ kind: source.kind, documentId }),
    kind: source.kind,
    kindLabel: source.label,
    documentId,
    name:
      typeof row?.name === 'string' && row.name.trim()
        ? row.name
        : `(untitled ${source.label.toLowerCase()})`,
  };
};

/** Read `{ results, pagination }` out of either response envelope shape. */
const unwrap = (response: any) => response?.data?.data ?? response?.data ?? {};

async function fetchSourcePage(
  client: FetchClient,
  source: (typeof CHECKOUT_MERCHANT_SOURCES)[number],
  search: string,
  page: number,
): Promise<MerchantPage> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(MERCHANT_PAGE_SIZE),
    sort: 'name:ASC',
  });
  if (search) params.set('filters[name][$containsi]', search);

  try {
    const response = await client.get(
      `/content-manager/collection-types/${source.target}?${params.toString()}`,
    );
    const body = unwrap(response);
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    const pageCount = body?.pagination?.pageCount ?? 1;
    return {
      options: results
        .map((row) => toOption(source, row))
        .filter((option): option is MerchantOption => option !== null),
      hasMore: page < pageCount,
    };
  } catch (err) {
    // One unreadable source must not blank the whole dropdown — a role with
    // Brand read revoked should still be able to pick a Store.
    console.error(
      `[checkout-merchant] failed to load ${source.target}`,
      err,
    );
    return { options: [], hasMore: false };
  }
}

/**
 * Fetch page `page` of BOTH sources and concatenate them, Stores before
 * Brands.
 *
 * Deliberately NOT re-sorted across sources. A merged alphabetical list would
 * reshuffle rows the editor is already looking at every time "load more"
 * appends a page — page 2's "Adidas" would jump above page 1's "Zara". Two
 * stable blocks, each alphabetical, is the honest rendering of two independent
 * paginated sources, and every row carries its Store/Brand tag anyway.
 */
export async function searchMerchants(
  client: FetchClient,
  search: string,
  page: number,
): Promise<MerchantSearchResult> {
  const pages = await Promise.all(
    CHECKOUT_MERCHANT_SOURCES.map((source) =>
      fetchSourcePage(client, source, search, page),
    ),
  );

  return {
    options: pages.flatMap((result) => result.options),
    hasMore: pages.some((result) => result.hasMore),
  };
}

/**
 * Resolve one stored reference to a display option.
 *
 * The dropdown can only render the selected value's LABEL if that value is
 * among its options, and an offer's saved merchant is very often not on the
 * first page of an unfiltered list. So the current value is always fetched by
 * documentId and prepended.
 *
 * Returns null when the target no longer exists — the caller renders that as a
 * visible "no longer exists" warning rather than an innocuous blank field,
 * because a silently empty dropdown reads as "no merchant set" and would be
 * saved back as exactly that.
 */
export async function findMerchantByRef(
  client: FetchClient,
  ref: CheckoutMerchantRef,
): Promise<MerchantOption | null> {
  const source = checkoutMerchantSource(ref.kind);
  const params = new URLSearchParams({
    page: '1',
    pageSize: '1',
    'filters[documentId][$eq]': ref.documentId,
  });

  try {
    const response = await client.get(
      `/content-manager/collection-types/${source.target}?${params.toString()}`,
    );
    const body = unwrap(response);
    const row = Array.isArray(body?.results) ? body.results[0] : null;
    return row ? toOption(source, row) : null;
  } catch (err) {
    console.error(
      `[checkout-merchant] failed to resolve ${ref.kind}:${ref.documentId}`,
      err,
    );
    return null;
  }
}

/**
 * Prepend `selected` to `options` unless it is already there.
 *
 * Exported for the component and pinned by tests because getting it wrong is
 * invisible until it matters: a duplicate option makes React complain about
 * repeated keys, and a MISSING one makes the Combobox render the saved
 * merchant as an empty box.
 */
export function withSelectedOption(
  options: readonly MerchantOption[],
  selected: MerchantOption | null,
): MerchantOption[] {
  if (!selected) return [...options];
  if (options.some((option) => option.value === selected.value)) {
    return [...options];
  }
  return [selected, ...options];
}
