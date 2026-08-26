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
import { useCouponLayoutDraft } from '../use-coupon-layout-draft';
import type { EntityCouponLayout } from '../use-entity-coupon-layout';
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
  layout,
  open,
  onOpenChange,
  onSaved,
  onReloadRequested,
  onDropped,
}: {
  config: CouponLayoutConfig;
  documentId?: string;
  layout: EntityCouponLayout;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (layout: EntityCouponLayout) => void;
  /** Refetch the layout from the server — used to recover from a 409. */
  onReloadRequested: () => void;
  /** Report picks the backend self-healed out of the saved selection. */
  onDropped: (message: string) => void;
}) {
  const {
    topPicks,
    ordered,
    edited,
    saving,
    saveError,
    autoRemoved,
    unresolvedConflicts,
    shownTopPickIds,
    save,
    requestClose,
  } = useCouponLayoutDraft({
    config,
    documentId,
    layout,
    onOpenChange,
    onSaved,
    onReloadRequested,
    onDropped,
  });

  const [showPreview, setShowPreview] = React.useState(false);

  // Re-read the saved order every time the preview is opened, so it never
  // shows what an earlier session left behind — and costs nothing while the
  // section stays collapsed.
  const [previewToken, setPreviewToken] = React.useState(0);
  React.useEffect(() => {
    if (open && showPreview) setPreviewToken((token) => token + 1);
  }, [open, showPreview]);

  // The PERSISTED ordered ids, not the pending selection: this is what the
  // preview diffs against to mark rows as unsaved.
  const savedOrderedIds = React.useMemo(
    () => layout.orderedCoupons.map((coupon) => coupon.documentId),
    [layout.orderedCoupons],
  );
  const preview = useOrderPreview(
    config,
    documentId,
    open && showPreview,
    previewToken,
    topPicks.selected,
    ordered.selected,
    savedOrderedIds,
  );

  return (
    <Modal.Root open={open} onOpenChange={requestClose}>
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
          <Button
            type="button"
            variant="tertiary"
            disabled={saving}
            onClick={() => requestClose(false)}
          >
            Cancel
          </Button>
          <Flex gap={3}>
            {saveError ? (
              <Typography variant="pi" textColor="danger600">
                {saveError}
              </Typography>
            ) : null}
            <Button
              type="button"
              loading={saving}
              disabled={!edited || saving}
              onClick={save}
            >
              Save Coupon layout
            </Button>
          </Flex>
        </Modal.Footer>
      </DialogContent>
    </Modal.Root>
  );
}
