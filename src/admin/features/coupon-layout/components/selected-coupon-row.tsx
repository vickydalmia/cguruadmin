import { Box, Flex, IconButton, Typography } from '@strapi/design-system';
import { ArrowDown, ArrowUp, Cross, Drag } from '@strapi/icons';
import * as React from 'react';
import { useDrag, useDrop } from 'react-dnd';
import styled from 'styled-components';

import type { CouponCandidate } from '../coupon-layout';
import { CouponMeta } from './coupon-meta';

/**
 * One row of an ordered selection.
 *
 * Only the grip is draggable so the row's own buttons stay clickable. The
 * up/down buttons are not decoration — they are the keyboard-accessible path,
 * since HTML5 drag-and-drop is not.
 */

const DropLine = styled.div<{ $active: boolean }>`
  height: 2px;
  margin-bottom: ${({ theme }) => theme.spaces[1]};
  background: ${({ theme, $active }) =>
    $active ? theme.colors.primary600 : 'transparent'};
  border-radius: 2px;
`;

const RowShell = styled.div<{ $dragging: boolean }>`
  opacity: ${({ $dragging }) => ($dragging ? 0.55 : 1)};
`;

const Grip = styled(IconButton)`
  cursor: grab;
  touch-action: none;

  &:active {
    cursor: grabbing;
  }
`;

type DragItem = { documentId: string; index: number };

/**
 * Move focus to the adjacent reorder button before this one is disabled.
 * Called on the click that takes a row to a list boundary, so the keyboard
 * user keeps a focused control instead of being dropped on document.body.
 */
function focusSibling(button: HTMLButtonElement, direction: 'up' | 'down') {
  const sibling =
    direction === 'up'
      ? button.previousElementSibling
      : button.nextElementSibling;
  if (sibling instanceof HTMLButtonElement && !sibling.disabled) {
    sibling.focus();
  }
}

export function SelectedCouponRow({
  candidate,
  index,
  count,
  dragType,
  positionLabel,
  onDrop,
  onMove,
  onRemove,
}: {
  candidate: CouponCandidate;
  index: number;
  count: number;
  /**
   * Distinct per list. Top Picks and the ordered head sit side by side, and
   * these are two separate relations — a row dragged across would silently
   * move a Coupon between them.
   */
  dragType: string;
  /** Extra context for the position, e.g. "shown" or "expiry buffer". */
  positionLabel?: string;
  onDrop: (draggedDocumentId: string, targetDocumentId: string) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (documentId: string) => void;
}) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const handleRef = React.useRef<HTMLButtonElement>(null);

  const [{ isDragging }, drag, preview] = useDrag(
    () => ({
      type: dragType,
      item: { documentId: candidate.documentId, index },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [candidate.documentId, index, dragType],
  );

  const [{ isOver, fromAbove }, drop] = useDrop(
    () => ({
      accept: dragType,
      collect: (monitor) => ({
        isOver: monitor.isOver() && monitor.getItem()?.documentId !== candidate.documentId,
        fromAbove: (monitor.getItem() as DragItem | null)?.index ?? -1,
      }),
      drop: (item: DragItem) => {
        if (item.documentId !== candidate.documentId) {
          onDrop(item.documentId, candidate.documentId);
        }
      },
    }),
    [candidate.documentId, onDrop, dragType],
  );

  drag(handleRef);
  drop(preview(rowRef));

  // Show the insertion line on the side the row will actually land on, so the
  // drop is predictable instead of a guess.
  const showLineAbove = isOver && fromAbove > index;
  const showLineBelow = isOver && fromAbove >= 0 && fromAbove < index;

  return (
    <div ref={rowRef}>
      <DropLine $active={showLineAbove} />
      <RowShell $dragging={isDragging}>
        <Box
          hasRadius
          background="primary100"
          borderColor="primary200"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={2}
          paddingBottom={2}
          width="100%"
        >
          <Flex alignItems="center" gap={1} width="100%">
            <Grip
              ref={handleRef}
              type="button"
              label={`Drag to reorder ${candidate.name}`}
              variant="ghost"
              size="S"
            >
              <Drag />
            </Grip>

            <Box style={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="pi"
                fontWeight="bold"
                textColor="primary600"
                style={{ display: 'block', overflowWrap: 'anywhere' }}
              >
                {index + 1}. {candidate.name}
              </Typography>
              <CouponMeta candidate={candidate} extra={positionLabel} />
            </Box>

            {/*
              A keyboard user repeatedly pressing Up to walk a row to the top
              lands on a button that becomes `disabled` in the SAME commit, so
              focus falls to document.body and they lose their place mid
              reorder. Hand focus to the opposite button instead, which is
              where the next useful action is.
            */}
            <IconButton
              type="button"
              label={`Move ${candidate.name} up`}
              variant="ghost"
              size="S"
              disabled={index === 0}
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                const nextIndex = index - 1;
                if (nextIndex === 0) focusSibling(event.currentTarget, 'down');
                onMove(index, nextIndex);
              }}
            >
              <ArrowUp />
            </IconButton>
            <IconButton
              type="button"
              label={`Move ${candidate.name} down`}
              variant="ghost"
              size="S"
              disabled={index === count - 1}
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                const nextIndex = index + 1;
                if (nextIndex === count - 1) {
                  focusSibling(event.currentTarget, 'up');
                }
                onMove(index, nextIndex);
              }}
            >
              <ArrowDown />
            </IconButton>
            <IconButton
              type="button"
              label={`Remove ${candidate.name}`}
              variant="ghost"
              size="S"
              onClick={() => onRemove(candidate.documentId)}
            >
              <Cross />
            </IconButton>
          </Flex>
        </Box>
      </RowShell>
      <DropLine $active={showLineBelow} />
    </div>
  );
}
