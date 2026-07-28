import {
  Box,
  Button,
  Checkbox,
  Flex,
  Loader,
  Searchbar,
  SingleSelect,
  SingleSelectOption,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';
import styled from 'styled-components';

import type { CouponLayoutConfig } from '../config';
import { candidateDisabled, type CouponCandidate } from '../coupon-layout';
import { useCouponPool, type PoolSort } from '../use-coupon-pool';
import type { RelationSelection } from '../use-relation-selection';
import { CouponMeta } from './coupon-meta';
import { SelectedCouponRow } from './selected-coupon-row';

/**
 * One half of the dialog: the selection list on top, its own search and
 * candidate list underneath.
 *
 * This is the sidebar panel's layout given real width. Each half owns its own
 * search so the two selections can be worked on independently, the way editors
 * actually use them.
 */

/** Takes every pixel the column has left rather than a fixed slice of it. */
const PoolScroller = styled(Box)`
  flex: 1;
  min-height: 12rem;
  overflow-y: auto;
`;

/**
 * The selection is the drag target, so it gets its own scroll rather than
 * pushing the candidate list off-screen once ten Coupons are picked.
 */
const SelectionScroller = styled(Flex)`
  max-height: 40%;
  overflow-y: auto;
`;

const CandidateRow = styled(Box)`
  border-bottom: 1px solid ${({ theme }) => theme.colors.neutral150};

  &:last-child {
    border-bottom: none;
  }
`;

export function CouponColumn({
  title,
  description,
  config,
  documentId,
  selection,
  maxSelections,
  dragType,
  slotLabel,
  emptyLabel,
  requiresLiveCoupons,
  warning,
  blockedIds,
  blockedNote,
  open,
}: {
  title: string;
  description: string;
  config: CouponLayoutConfig;
  documentId?: string;
  selection: RelationSelection;
  maxSelections: number;
  /** Distinct per column so a row cannot be dragged into the other list. */
  dragType: string;
  slotLabel?: (index: number) => string;
  /**
   * What the page does when this list is empty. Say the actual behaviour —
   * "automatic" reads as jargon and leaves editors guessing.
   */
  emptyLabel: string;
  /**
   * Minimum live Coupons the entry needs before this list can do anything.
   * Below it the whole half is disabled rather than accepting a selection
   * that would never render.
   */
  requiresLiveCoupons?: number;
  warning?: string | null;
  /**
   * Coupons that must not be ADDED here because the other list already renders
   * them. The server validates the same final positional rule.
   */
  blockedIds: ReadonlySet<string>;
  blockedNote: string;
  open: boolean;
}) {
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<PoolSort>('newest');
  const pool = useCouponPool(config, documentId, search, sort, open);

  const selectedIds = React.useMemo(
    () => new Set(selection.selected.map((item) => item.documentId)),
    [selection.selected],
  );
  const atLimit = selection.selected.length >= maxSelections;
  // The section is hidden on the page below this threshold, so a selection
  // here would be a silent no-op. `libraryTotal` ignores the search box; wait
  // for it rather than blocking the column while it is still null.
  const tooFewCoupons =
    requiresLiveCoupons != null &&
    pool.libraryTotal != null &&
    pool.libraryTotal < requiresLiveCoupons;

  const toggle = (candidate: CouponCandidate) => {
    if (selectedIds.has(candidate.documentId)) {
      selection.remove(candidate.documentId);
      return;
    }
    selection.add(candidate);
  };

  return (
    <Flex
      direction="column"
      alignItems="stretch"
      gap={2}
      style={{ minHeight: 0 }}
    >
      <Box>
        <Typography variant="sigma" textColor="neutral600">
          {title} ({selection.selected.length}/{maxSelections})
        </Typography>
        <Typography
          variant="pi"
          textColor="neutral500"
          tag="p"
          style={{ marginTop: 2 }}
        >
          {description}
        </Typography>
      </Box>

      {tooFewCoupons ? (
        <Box hasRadius background="neutral100" padding={3}>
          <Typography variant="pi" textColor="neutral600">
            This entry has {pool.libraryTotal} live Coupon
            {pool.libraryTotal === 1 ? '' : 's'}. The section needs at least{' '}
            {requiresLiveCoupons} to appear on the page, so there is nothing to
            choose yet.
          </Typography>
        </Box>
      ) : null}

      {warning ? (
        <Box
          hasRadius
          background="warning100"
          borderColor="warning200"
          padding={2}
        >
          <Typography variant="pi" textColor="warning600">
            {warning}
          </Typography>
        </Box>
      ) : null}

      {selection.loading ? (
        <Flex justifyContent="center" padding={2}>
          <Loader small>Loading selection</Loader>
        </Flex>
      ) : selection.selected.length === 0 ? (
        <Typography variant="pi" textColor="neutral500">
          {emptyLabel}
        </Typography>
      ) : (
        <SelectionScroller direction="column" alignItems="stretch" gap={1}>
          {selection.selected.map((candidate, index) => (
            <SelectedCouponRow
              key={candidate.documentId}
              candidate={candidate}
              index={index}
              count={selection.selected.length}
              dragType={dragType}
              positionLabel={slotLabel?.(index)}
              onDrop={selection.moveByDocumentId}
              onMove={selection.move}
              onRemove={selection.remove}
            />
          ))}
        </SelectionScroller>
      )}

      <Flex gap={2} alignItems="flex-end">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Searchbar
            name={`${dragType}-search`}
            value={search}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setSearch(event.target.value)
            }
            onClear={() => setSearch('')}
            clearLabel="Clear Coupon search"
            placeholder="Search by title"
            size="S"
          >
            Search Coupons
          </Searchbar>
        </Box>
        <Box style={{ width: '14rem' }}>
          <SingleSelect
            aria-label={`Sort Coupons for ${title}`}
            value={sort}
            onChange={(value: string | number) =>
              setSort(String(value) as PoolSort)
            }
            size="S"
          >
            <SingleSelectOption value="newest">Newest first</SingleSelectOption>
            <SingleSelectOption value="title">Title A–Z</SingleSelectOption>
          </SingleSelect>
        </Box>
      </Flex>

      {atLimit ? (
        <Typography variant="pi" textColor="neutral600">
          Limit of {maxSelections} reached. Remove one above to add another.
        </Typography>
      ) : null}

      <PoolScroller
        hasRadius
        background="neutral0"
        borderColor="neutral200"
        padding={2}
      >
        {pool.error ? (
          <Flex direction="column" alignItems="center" gap={2} padding={3}>
            <Typography variant="pi" textColor="danger600">
              {pool.error}
            </Typography>
            <Button
              type="button"
              variant="secondary"
              size="S"
              onClick={pool.retry}
            >
              Retry candidates
            </Button>
          </Flex>
        ) : null}
        {pool.candidates.map((candidate) => {
          const isSelected = selectedIds.has(candidate.documentId);
          const isBlocked = blockedIds.has(candidate.documentId);
          return (
            <CandidateRow
              key={candidate.documentId}
              paddingTop={2}
              paddingBottom={2}
            >
              <Checkbox
                checked={isSelected}
                disabled={candidateDisabled({
                  isSelected,
                  isBlocked,
                  atLimit,
                  tooFewCoupons,
                  selectionLoading: selection.loading,
                })}
                onCheckedChange={() => toggle(candidate)}
              >
                <Box style={{ minWidth: 0 }}>
                  <Typography
                    variant="pi"
                    fontWeight={isSelected ? 'bold' : 'normal'}
                    style={{ overflowWrap: 'anywhere' }}
                  >
                    {candidate.name}
                  </Typography>
                  <CouponMeta
                    candidate={candidate}
                    extra={isBlocked ? blockedNote : null}
                  />
                </Box>
              </Checkbox>
            </CandidateRow>
          );
        })}

        {pool.loading ? (
          <Flex justifyContent="center" padding={2}>
            <Loader small>Loading</Loader>
          </Flex>
        ) : null}

        {!pool.loading && !pool.error && pool.candidates.length === 0 ? (
          <Typography variant="pi" textColor="neutral500">
            {search
              ? 'No Coupons match that search.'
              : 'No live Coupons are related to this entry yet.'}
          </Typography>
        ) : null}

        {pool.hasMore && !pool.loading ? (
          <Flex justifyContent="center" padding={2}>
            <Button
              type="button"
              variant="tertiary"
              size="S"
              onClick={pool.loadMore}
            >
              Load more
            </Button>
          </Flex>
        ) : null}
      </PoolScroller>
    </Flex>
  );
}
