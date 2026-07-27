import {
  Box,
  Button,
  Divider,
  Flex,
  Modal,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';
import styled from 'styled-components';

import {
  ORDERED_MAX,
  TOP_PICK_DISPLAYED,
  TOP_PICK_MAX,
  type CouponLayoutConfig,
} from '../config';
import { topPickSlotRole } from '../coupon-layout';
import { useOrderPreview } from '../use-order-preview';
import type { RelationSelection } from '../use-relation-selection';
import { CouponColumn } from './coupon-column';
import { OrderPreview } from './order-preview';

/**
 * The dialog claims a fixed share of the viewport and hands all of it to the
 * two lists. Everything below is flex with `min-height: 0` so the candidate
 * scrollers absorb the leftover height instead of the body growing and pushing
 * the working area into a sliver.
 */
const DialogContent = styled(Modal.Content)`
  width: min(140rem, calc(100vw - 3.2rem));
  max-width: none;
  height: min(92vh, 100rem);
`;

const Body = styled(Modal.Body)`
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
`;

/** Two halves. The sidebar panel's job with room to actually do it. */
const Halves = styled.div`
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: ${({ theme }) => theme.spaces[6]};

  @media (max-width: 920px) {
    grid-template-columns: minmax(0, 1fr);
    overflow-y: auto;
  }
`;

const PreviewToggle = styled.button`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spaces[2]};
  padding: ${({ theme }) => `${theme.spaces[2]} 0`};
  background: none;
  border: none;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.primary600};
    outline-offset: 2px;
  }
`;

const PreviewPane = styled(Box)`
  max-height: 26vh;
  overflow-y: auto;
`;

/**
 * Nothing is blocked in the Top Picks half: an ordered Coupon may be picked as
 * a buffer, and only becomes a problem once it is displayed — which the
 * warning covers and the cron repairs. Hoisted so the Set identity is stable
 * across renders.
 */
const EMPTY_IDS: ReadonlySet<string> = new Set();

export function CouponLayoutDialog({
  config,
  documentId,
  slug,
  topPicks,
  ordered,
  open,
  onOpenChange,
}: {
  config: CouponLayoutConfig;
  documentId?: string;
  slug?: string;
  /**
   * Owned by the sidebar panel, not created here — the panel renders the same
   * counts in its collapsed summary, and one shared state keeps the two from
   * disagreeing (and avoids reloading the relations on every open).
   */
  topPicks: RelationSelection;
  ordered: RelationSelection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [showPreview, setShowPreview] = React.useState(false);

  // Re-read the saved order every time the preview is opened, so it never
  // shows what an earlier session left behind — and costs nothing while the
  // section stays collapsed.
  const [previewToken, setPreviewToken] = React.useState(0);
  React.useEffect(() => {
    if (open && showPreview) setPreviewToken((token) => token + 1);
  }, [open, showPreview]);
  const preview = useOrderPreview(
    config,
    slug,
    open && showPreview,
    previewToken,
  );

  // Only the DISPLAYED Top Picks are barred from Ordered Coupons. Positions
  // 3-4 are expiry buffers the page never renders, so ordering them in the
  // main list meanwhile is exactly what they are for.
  const shownTopPickIds = React.useMemo(
    () =>
      new Set(
        topPicks.selected
          .slice(0, TOP_PICK_DISPLAYED)
          .map((item) => item.documentId),
      ),
    [topPicks.selected],
  );
  const orderedIds = React.useMemo(
    () => new Set(ordered.selected.map((item) => item.documentId)),
    [ordered.selected],
  );

  // A Coupon sitting in a SHOWN Top Pick slot and in Ordered Coupons at once.
  // Reachable by dragging a buffer upward, or by an ordered Coupon being
  // picked into the first two slots.
  const conflicting = React.useMemo(
    () =>
      topPicks.selected
        .slice(0, TOP_PICK_DISPLAYED)
        .filter((item) => orderedIds.has(item.documentId)),
    [topPicks.selected, orderedIds],
  );

  // Resolve it HERE, in the same edit, rather than leaving it for the cron.
  // The cron cannot see the intended order of a relation patch, but this
  // dialog owns that order, so it can drop the Coupon out of Ordered Coupons
  // immediately — the editor watches it happen instead of finding it changed
  // five minutes later. The cron stays as the backstop for writes that do not
  // come through here.
  const [autoRemoved, setAutoRemoved] = React.useState<string[]>([]);
  const edited = topPicks.dirty || ordered.dirty;
  React.useEffect(() => {
    // While either list is loading its selection is empty, which would read as
    // "no conflict" and, worse, could remove against a half-known state.
    if (topPicks.loading || ordered.loading) return;
    // ONLY repair a conflict the editor just created. The cron can leave this
    // state behind legitimately (it promotes a buffer into a displayed slot),
    // and acting on merely opening the dialog would queue a disconnect and
    // mark the entry dirty for someone who came to look — "Done" would not
    // undo it, and a later save for an unrelated field would persist an
    // ordering change they never made. Pre-existing conflicts are the cron's.
    if (!edited) return;
    if (conflicting.length === 0) return;

    ordered.removeMany(conflicting.map((item) => item.documentId));
    setAutoRemoved((current) => [
      ...new Set([...current, ...conflicting.map((item) => item.name)]),
    ]);
    // Removing empties `conflicting`, so the next pass returns early — this
    // converges rather than looping.
  }, [
    conflicting,
    edited,
    ordered.removeMany,
    ordered.loading,
    topPicks.loading,
  ]);

  // Left behind by the cron's buffer promotion, or a direct API write. Not
  // touched automatically — only described, with the fix one click away.
  const unresolvedConflicts = React.useMemo(
    () => (edited ? [] : conflicting.map((item) => item.name)),
    [edited, conflicting],
  );

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Modal.Header closeLabel="Close Coupon layout">
          <Modal.Title>Coupon layout</Modal.Title>
        </Modal.Header>

        <Body>
          <Flex
            direction="column"
            alignItems="stretch"
            gap={3}
            style={{ minHeight: 0, flex: 1 }}
          >
            <Halves>
              <CouponColumn
                title="Top Pick Coupons"
                description={`First ${TOP_PICK_DISPLAYED} are shown in this order · the rest wait as expiry buffers`}
                emptyLabel={`Nothing selected — the page shows the ${TOP_PICK_DISPLAYED} newest Coupons here.`}
                config={config}
                documentId={documentId}
                selection={topPicks}
                maxSelections={TOP_PICK_MAX}
                dragType="coupon-layout-top-pick"
                slotLabel={(index) =>
                  topPickSlotRole(index) === 'shown'
                    ? 'shown'
                    : 'expiry buffer — may also be ordered'
                }
                requiresLiveCoupons={TOP_PICK_DISPLAYED}
                blockedIds={EMPTY_IDS}
                blockedNote=""
                open={open}
              />

              <CouponColumn
                title="Ordered Coupons"
                description="These lead the main list in this order · every other Coupon follows newest-first"
                emptyLabel="Nothing selected — the whole main list stays newest-first."
                config={config}
                documentId={documentId}
                selection={ordered}
                maxSelections={ORDERED_MAX}
                dragType="coupon-layout-ordered"
                // Shown on THIS column: it is where the rows disappeared from.
                warning={
                  autoRemoved.length > 0
                    ? `${autoRemoved.join(', ')} ${autoRemoved.length === 1 ? 'was' : 'were'} removed from this list — a shown Top Pick is taken out of the main list, so it cannot hold a position here. Expiry buffers can.`
                    : unresolvedConflicts.length > 0
                      ? `${unresolvedConflicts.join(', ')} ${unresolvedConflicts.length === 1 ? 'is' : 'are'} also a shown Top Pick, so it is not rendered in this list. Remove it here, or leave it — the cleanup job drops it within five minutes.`
                      : null
                }
                blockedIds={shownTopPickIds}
                blockedNote="shown as a Top Pick"
                open={open}
              />
            </Halves>

            <Divider />

            {/*
              Reference, not the working area — collapsed so the lists above
              keep the height. The state lives here so reopening is instant.
            */}
            <Box>
              <PreviewToggle
                type="button"
                aria-expanded={showPreview}
                onClick={() => setShowPreview((current) => !current)}
              >
                <Typography variant="sigma" textColor="neutral600">
                  {showPreview ? '▾' : '▸'} Resulting order
                </Typography>
                <Typography variant="pi" textColor="neutral500">
                  titles in sequence, from the public API — not a page render
                </Typography>
              </PreviewToggle>

              {showPreview ? (
                <PreviewPane paddingTop={2}>
                  <OrderPreview
                    source={preview}
                    // Null until loaded, so the preview labels the head from
                    // the saved ids rather than tagging every ordered Coupon
                    // "newest-first" while the relation request is in flight.
                    pendingOrdered={ordered.loading ? null : ordered.selected}
                    pendingTopPicks={topPicks.selected}
                  />
                </PreviewPane>
              ) : null}
            </Box>
          </Flex>
        </Body>

        <Modal.Footer>
          <Modal.Close>
            <Button type="button" variant="tertiary">
              Done
            </Button>
          </Modal.Close>
          <Typography variant="pi" textColor="neutral600">
            Remember to save the entry to apply these changes.
          </Typography>
        </Modal.Footer>
      </DialogContent>
    </Modal.Root>
  );
}
