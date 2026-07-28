import {
  Box,
  Button,
  Divider,
  Flex,
  Modal,
  Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';
import styled from 'styled-components';

import {
  ORDERED_MAX,
  TOP_PICK_DISPLAYED,
  TOP_PICK_MAX,
  type CouponLayoutConfig,
} from '../config';
import { toCandidate, topPickSlotRole } from '../coupon-layout';
import { useOrderPreview } from '../use-order-preview';
import { useLocalRelationSelection } from '../use-relation-selection';
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
  const { put } = useFetchClient();
  const topPicks = useLocalRelationSelection(
    layout.topPickCoupons,
    TOP_PICK_MAX,
  );
  const ordered = useLocalRelationSelection(
    layout.orderedCoupons,
    ORDERED_MAX,
  );
  const [showPreview, setShowPreview] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Re-read the saved order every time the preview is opened, so it never
  // shows what an earlier session left behind — and costs nothing while the
  // section stays collapsed.
  const [previewToken, setPreviewToken] = React.useState(0);
  React.useEffect(() => {
    if (open && showPreview) setPreviewToken((token) => token + 1);
  }, [open, showPreview]);
  // Adopt the server's state whenever its version moves while this dialog is
  // open — which is exactly what a 409 recovery does.
  //
  // useLocalRelationSelection seeds from `initial` only on mount, and the
  // panel renders this dialog without a key, so a refetch swapped in the
  // winner's `layout.version` while the visible selections stayed the losing
  // draft. The next save then matched on version and SILENTLY overwrote the
  // other editor's layout — strictly worse than the 409 loop it replaced.
  // Discarding the draft is the point: the editor is told to reapply.
  const appliedVersionRef = React.useRef(layout.version);
  React.useEffect(() => {
    if (appliedVersionRef.current === layout.version) return;
    appliedVersionRef.current = layout.version;
    topPicks.reset(layout.topPickCoupons);
    ordered.reset(layout.orderedCoupons);
  }, [
    layout.version,
    layout.topPickCoupons,
    layout.orderedCoupons,
    topPicks.reset,
    ordered.reset,
  ]);

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
  const requestClose = React.useCallback(
    (nextOpen: boolean) => {
      if (
        !nextOpen &&
        edited &&
        !globalThis.confirm('Discard unsaved Coupon layout changes?')
      ) {
        return;
      }
      onOpenChange(nextOpen);
    },
    [edited, onOpenChange],
  );

  const save = React.useCallback(async () => {
    if (!documentId || !edited || saving) return;
    setSaving(true);
    setSaveError(null);
    // ONLY the request belongs in the try. Mapping the response, notifying the
    // parent and closing all used to sit here too, so a throw in any of them
    // reported "could not be saved" for a write that had already committed —
    // and the retry then conflicted forever against the bumped version.
    let response: any;
    try {
      response = await put(
        `/entity-coupon-layout/${config.kind}/${encodeURIComponent(documentId)}`,
        {
          data: {
            version: layout.version,
            topPickCouponIds: topPicks.selected.map(
              (coupon) => coupon.documentId,
            ),
            orderedCouponIds: ordered.selected.map(
              (coupon) => coupon.documentId,
            ),
          },
        },
      );
    } catch (error: any) {
      // The HTTP status lives on the error itself. `error.response` is
      // `{ data }` only, so the old `error.response.status` was always
      // undefined and this branch never ran.
      if (Number(error?.status) === 409) {
        // Refetch so the editor is working from the winning version. Telling
        // them to close and reopen did nothing: reopening reuses the same
        // loaded layout and re-sends the same stale version forever.
        onReloadRequested();
        setSaveError(
          'Another editor changed this layout. It has been reloaded with their version — reapply your changes and save again.',
        );
      } else {
        setSaveError(
          error?.response?.data?.error?.message ??
            'Coupon layout could not be saved. Your draft is still open.',
        );
      }
      setSaving(false);
      return;
    }
    setSaving(false);

    const body = response?.data?.data ?? response?.data;
    // toCandidate, not a hand-rolled spread: it is what derives `offerType`
    // and `detailed` from the same server projection the GET path uses.
    // Without them every saved row rendered "NO CODE" and lost its expiry
    // label until the page was reloaded.
    const saved: EntityCouponLayout = {
      ...body,
      topPickCoupons: (body?.topPickCoupons ?? []).map(toCandidate),
      orderedCoupons: (body?.orderedCoupons ?? []).map(toCandidate),
    };
    // The backend self-heals saved picks that are no longer live. Say so
    // rather than leaving the editor with a layout they did not submit.
    const dropped: any[] = Array.isArray(body?.dropped) ? body.dropped : [];
    if (dropped.length > 0) {
      const names = dropped
        .map((entry) => entry?.title)
        .filter(Boolean)
        .join(', ');
      onDropped(
        dropped.length === 1
          ? `1 Coupon was removed because it is no longer live${names ? `: ${names}` : ''}.`
          : `${dropped.length} Coupons were removed because they are no longer live${names ? `: ${names}` : ''}.`,
      );
    }
    onSaved(saved);
    onOpenChange(false);
  }, [
    config.kind,
    documentId,
    edited,
    layout.version,
    onOpenChange,
    onSaved,
    ordered.selected,
    put,
    saving,
    topPicks.selected,
  ]);
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
