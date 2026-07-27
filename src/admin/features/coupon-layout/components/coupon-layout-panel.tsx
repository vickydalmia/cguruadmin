import { useForm } from '@strapi/strapi/admin';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import * as React from 'react';

import {
  couponLayoutConfig,
  ORDERED_FIELD,
  ORDERED_MAX,
  TOP_PICK_DISPLAYED,
  TOP_PICK_FIELD,
  TOP_PICK_MAX,
  type CouponLayoutConfig,
} from '../config';
import { useDeferredMount } from '../use-deferred-mount';
import { useRelationSelection } from '../use-relation-selection';
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
  model,
  documentId,
}: {
  config: CouponLayoutConfig;
  model: string;
  documentId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ready = useDeferredMount();

  const topPicks = useRelationSelection(
    TOP_PICK_FIELD,
    model,
    documentId,
    TOP_PICK_MAX,
    ready,
  );
  const ordered = useRelationSelection(
    ORDERED_FIELD,
    model,
    documentId,
    ORDERED_MAX,
    ready,
  );
  const slug = useForm('CouponLayoutPanel', (state: any) => state.values?.slug);

  if (!documentId) {
    return (
      <Box paddingTop={2} paddingBottom={2}>
        <Typography variant="pi" textColor="neutral600">
          Save this entry first. Its related Coupons can then be arranged here.
        </Typography>
      </Box>
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
        topPicks.selected.length,
        TOP_PICK_MAX,
        `newest ${TOP_PICK_DISPLAYED}`,
        topPicks.loading,
      )}
      {summary(
        'Ordered head',
        ordered.selected.length,
        ORDERED_MAX,
        'newest-first',
        ordered.loading,
      )}

      <Button
        type="button"
        variant="secondary"
        fullWidth
        onClick={() => setOpen(true)}
      >
        Arrange Coupons
      </Button>

      {open ? (
        <CouponLayoutDialog
          config={config}
          documentId={documentId}
          slug={typeof slug === 'string' ? slug : undefined}
          topPicks={topPicks}
          ordered={ordered}
          open={open}
          onOpenChange={setOpen}
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
        model={model}
        documentId={documentId}
      />
    ),
  };
}
