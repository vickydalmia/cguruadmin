import { Box, Button, Flex, Typography } from '@strapi/design-system';
import * as React from 'react';

import {
  couponLayoutConfig,
  ORDERED_MAX,
  TOP_PICK_DISPLAYED,
  TOP_PICK_MAX,
  type CouponLayoutConfig,
} from '../config';
import { useDeferredMount } from '../use-deferred-mount';
import { useEntityCouponLayout } from '../use-entity-coupon-layout';
import { CouponLayoutDialog } from './coupon-layout-dialog';

/**
 * Collapsed summary in the edit-view sidebar.
 *
 * The counts come from the same `useRelationSelection` state the dialog edits,
 * loaded here rather than inside the dialog. Deriving them from the Content
 * Manager form value instead does NOT work: the form carries only pending
 * connect/disconnect edits, not the persisted relation, so the summary read
 * zero for every saved entity and claimed the sections were automatic when
 * they were curated.
 *
 * Sharing the state also means opening the dialog costs no second load, and
 * the summary reflects unsaved edits immediately.
 */
export function CouponLayoutPanelBody({
  config,
  documentId,
}: {
  config: CouponLayoutConfig;
  documentId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  // Set when a save self-healed picks that had gone stale, so the change is
  // never made silently under the editor.
  const [droppedNotice, setDroppedNotice] = React.useState<string | null>(null);
  const ready = useDeferredMount();

  const layout = useEntityCouponLayout(config, documentId, ready);

  if (!documentId) {
    return (
      <Box paddingTop={2} paddingBottom={2}>
        <Typography variant="pi" textColor="neutral600">
          Save this entry first. Its related Coupons can then be arranged here.
        </Typography>
      </Box>
    );
  }

  if (layout.error) {
    return (
      <Flex direction="column" alignItems="stretch" gap={2} paddingTop={2}>
        <Typography variant="pi" textColor="danger600">
          {layout.error}
        </Typography>
        <Button type="button" variant="secondary" onClick={layout.retry}>
          Retry
        </Button>
      </Flex>
    );
  }

  const summary = (
    label: string,
    count: number,
    max: number,
    emptyLabel: string,
    loading: boolean,
  ) => (
    <Typography variant="pi" textColor="neutral600">
      {label}: {loading ? '…' : count === 0 ? emptyLabel : `${count}/${max}`}
    </Typography>
  );

  return (
    <Flex
      direction="column"
      alignItems="stretch"
      gap={2}
      paddingTop={2}
      paddingBottom={2}
    >
      {summary(
        'Top Picks',
        layout.data?.counts.topPicks ?? 0,
        TOP_PICK_MAX,
        `newest ${TOP_PICK_DISPLAYED}`,
        layout.loading,
      )}
      {summary(
        'Ordered head',
        layout.data?.counts.ordered ?? 0,
        ORDERED_MAX,
        'newest-first',
        layout.loading,
      )}

      {layout.data?.capabilities?.reason ? (
        <Typography variant="pi" textColor="neutral600">
          {layout.data.capabilities.reason}
        </Typography>
      ) : null}
      {layout.data?.refresh ? (
        <Typography
          variant="pi"
          textColor={
            layout.data.refresh.state === 'failed'
              ? 'danger600'
              : 'success600'
          }
        >
          {layout.data.refresh.state === 'rendered'
            ? 'Public page updated'
            : layout.data.refresh.state === 'failed'
              ? 'Saved, but public refresh failed and will need retrying.'
              : 'Saved—refresh queued'}
        </Typography>
      ) : null}

      {droppedNotice ? (
        <Typography variant="pi" textColor="warning600" role="status">
          {droppedNotice}
        </Typography>
      ) : null}

      <Button
        type="button"
        variant="secondary"
        fullWidth
        disabled={layout.loading || !layout.data?.capabilities?.canManageLayout}
        onClick={() => {
          setDroppedNotice(null);
          setOpen(true);
        }}
      >
        Arrange Coupons
      </Button>

      {open && layout.data ? (
        <CouponLayoutDialog
          config={config}
          documentId={documentId}
          layout={layout.data}
          open={open}
          onOpenChange={setOpen}
          onSaved={layout.replace}
          onReloadRequested={layout.retry}
          onDropped={setDroppedNotice}
        />
      ) : null}
    </Flex>
  );
}

export function couponLayoutPanel(model: string, documentId?: string) {
  const config = couponLayoutConfig(model);
  if (!config) return null;

  return {
    title: 'Coupon layout',
    content: (
      <CouponLayoutPanelBody
        config={config}
        documentId={documentId}
      />
    ),
  };
}
