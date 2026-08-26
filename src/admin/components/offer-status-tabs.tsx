import * as React from 'react';
import { useQueryParams } from '@strapi/strapi/admin';
import { Button, Flex } from '@strapi/design-system';
import { useParams } from 'react-router-dom';

import {
  isOfferModel,
  OFFER_STATUS_TABS,
  readStatusTab,
  withStatusTab,
  type OfferStatusTab,
} from '../utils/offer-status-filter';

/**
 * All / Published / Scheduled / Expired shortcuts on the Coupon and Product
 * Deal list views, so an editor can separate live offers from expired ones
 * without hand-building a filter every time.
 *
 * WHY A BUTTON ROW IN THE TOOLBAR, NOT A TAB STRIP
 * ------------------------------------------------
 * Strapi 5 offers exactly one list-view injection zone — `listView.actions`,
 * which renders in the toolbar beside the view-settings gear (see
 * ListViewPage's `endActions`). Rendering a full-width tab strip under the page
 * title would mean either overriding the whole ListView route or portalling out
 * of the injection zone, both of which break on any upstream markup change.
 * A compact segmented control sits where the zone actually is.
 *
 * The tabs write the SAME `filters.$and` clause the built-in filter UI writes
 * (see offer-status-filter.ts), so the two stay in sync in both directions
 * rather than fighting over the URL.
 */
const OfferStatusTabs = () => {
  const { slug } = useParams<{ slug: string }>();
  const [{ query }, setQuery] = useQueryParams<{
    filters?: unknown;
    page?: number;
  }>();

  // The injection zone renders on EVERY collection type; only the two with a
  // `contentStatus` lifecycle field get tabs.
  if (!isOfferModel(slug)) return null;

  const active = readStatusTab(query?.filters);

  const select = (tab: OfferStatusTab) => {
    // `page` resets because the filtered set is smaller than the one being
    // browsed — landing on page 4 of a 2-page result shows an empty table.
    setQuery({ filters: withStatusTab(query?.filters, tab), page: 1 });
  };

  return (
    <Flex gap={1} tag="nav" aria-label="Filter by status">
      {OFFER_STATUS_TABS.map(({ id, label }) => {
        const isActive = active === id;
        return (
          <Button
            key={id}
            size="S"
            variant={isActive ? 'secondary' : 'tertiary'}
            aria-pressed={isActive}
            onClick={() => select(id)}
          >
            {label}
          </Button>
        );
      })}
    </Flex>
  );
};

export default OfferStatusTabs;
