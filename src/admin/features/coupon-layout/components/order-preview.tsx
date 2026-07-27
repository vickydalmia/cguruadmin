import { Box, Flex, Loader, Typography } from '@strapi/design-system';
import * as React from 'react';
import styled from 'styled-components';

import { TOP_PICK_DISPLAYED } from '../config';
import { buildPreviewRows, type CouponCandidate } from '../coupon-layout';
import type { OrderPreviewSource } from '../use-order-preview';

/**
 * The resulting sequence, as a list of titles.
 *
 * This is deliberately NOT a page render and cannot be one: entity pages are
 * served only from the ISR store through the gateway, which has no preview
 * route. What it does show is exact, because the remainder comes straight from
 * the public endpoint rather than from ordering rules copied into the admin.
 */

const Scroller = styled(Box)`
  max-height: 32rem;
  overflow-y: auto;
`;

const Row = styled(Flex)<{ $pending: boolean }>`
  padding-block: ${({ theme }) => theme.spaces[1]};
  border-left: 3px solid
    ${({ theme, $pending }) =>
      $pending ? theme.colors.warning500 : 'transparent'};
  padding-left: ${({ theme }) => theme.spaces[2]};
`;

export function OrderPreview({
  source,
  pendingOrdered,
  pendingTopPicks,
}: {
  source: OrderPreviewSource;
  /** Null while the editor's selection is still loading. */
  pendingOrdered: CouponCandidate[] | null;
  pendingTopPicks: CouponCandidate[];
}) {
  // Which Coupons the Top Pick section actually renders. The storefront takes
  // the curated selections first, then fills any empty slot from the newest
  // eligible Coupons that are NOT in the ordered head — which is exactly the
  // remainder of this endpoint's sequence, already in that order.
  const displayedTopPicks = React.useMemo(() => {
    const curated = pendingTopPicks.slice(0, TOP_PICK_DISPLAYED);
    const taken = new Set(curated.map((pick) => pick.documentId));
    const orderedIds = new Set(
      (pendingOrdered ?? []).map((coupon) => coupon.documentId),
    );
    const fill = source.sequence.filter(
      (coupon) =>
        !taken.has(coupon.documentId) && !orderedIds.has(coupon.documentId),
    );
    return [
      ...curated.map((pick) => ({ pick, automatic: false })),
      ...fill
        .slice(0, TOP_PICK_DISPLAYED - curated.length)
        .map((pick) => ({ pick, automatic: true })),
    ];
  }, [pendingTopPicks, pendingOrdered, source.sequence]);

  const rows = React.useMemo(
    () =>
      buildPreviewRows(
        source.sequence,
        pendingOrdered,
        source.savedOrderedIds,
        displayedTopPicks.map((entry) => entry.pick.documentId),
      ),
    [source.sequence, source.savedOrderedIds, pendingOrdered, displayedTopPicks],
  );

  if (source.loading) {
    return (
      <Flex justifyContent="center" padding={4}>
        <Loader small>Loading the current order</Loader>
      </Flex>
    );
  }

  if (source.error) {
    return (
      <Box padding={3}>
        <Typography variant="pi" textColor="neutral600">
          {source.error}
        </Typography>
      </Box>
    );
  }

  const automaticSlots = displayedTopPicks.filter(
    (entry) => entry.automatic,
  ).length;
  // `total` counts the entity's full membership, which includes the Coupons
  // now shown as Top Picks rather than in this list.
  const remainder = Math.max(
    0,
    source.total - rows.length - displayedTopPicks.length,
  );

  return (
    <Flex direction="column" alignItems="stretch" gap={2}>
      <Typography variant="sigma" textColor="neutral600">
        Top Picks
      </Typography>
      <Box paddingLeft={2}>
        {displayedTopPicks.map((entry, index) => (
          <Typography
            key={entry.pick.documentId}
            variant="pi"
            tag="p"
            style={{ overflowWrap: 'anywhere' }}
          >
            {index + 1}. {entry.pick.name}
            {entry.automatic ? ' — automatic' : ''}
          </Typography>
        ))}
        {automaticSlots > 0 ? (
          <Typography variant="pi" tag="p" textColor="neutral600">
            {/*
              The automatic slots are named so the main list below can subtract
              them, but the storefront's fallback ranks by relevanceAt then id
              while this endpoint sorts by publishedOn/publishedAt/updatedAt.
              Those agree except on ties, so flag the slot as a prediction
              rather than presenting it as settled.
            */}
            {automaticSlots === 1 ? 'The automatic slot' : 'Automatic slots'}{' '}
            {automaticSlots === 1 ? 'is' : 'are'} filled at render time; on a
            tie the Coupon shown here can differ.
          </Typography>
        ) : null}
      </Box>

      <Box paddingTop={2}>
        <Typography variant="sigma" textColor="neutral600">
          Main list
        </Typography>
      </Box>
      <Scroller>
        {rows.map((row, index) => (
          <Row key={row.documentId} $pending={row.pending} alignItems="baseline" gap={2}>
            <Typography variant="pi" textColor="neutral500">
              {index + 1}
            </Typography>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Typography variant="pi" style={{ overflowWrap: 'anywhere' }}>
                {row.name}
              </Typography>
            </Box>
            <Typography
              variant="pi"
              textColor={row.source === 'ordered' ? 'primary600' : 'neutral500'}
            >
              {row.source === 'ordered' ? 'you pinned' : 'newest-first'}
              {row.pending ? ' · unsaved' : ''}
            </Typography>
          </Row>
        ))}
        {rows.length === 0 ? (
          <Typography variant="pi" textColor="neutral500">
            This entry has no live Coupons yet.
          </Typography>
        ) : null}
        {remainder > 0 ? (
          <Box paddingTop={2} paddingLeft={2}>
            <Typography variant="pi" textColor="neutral500">
              … {remainder} more, newest-first
            </Typography>
          </Box>
        ) : null}
      </Scroller>
    </Flex>
  );
}
