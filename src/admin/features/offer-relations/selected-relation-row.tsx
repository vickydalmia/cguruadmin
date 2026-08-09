import { Box, Flex, IconButton, Typography } from '@strapi/design-system';
import { ArrowDown, ArrowUp, Cross, Drag } from '@strapi/icons';
import * as React from 'react';
import { useDrag, useDrop } from 'react-dnd';

import type { RelationCandidate } from '../../utils/single-relation';

export function SelectedRelationRow({
  candidate,
  index,
  count,
  reorderable,
  removeDisabled,
  onDrop,
  onMove,
  onRemove,
}: {
  candidate: RelationCandidate;
  index: number;
  count: number;
  reorderable: boolean;
  removeDisabled: boolean;
  onDrop: (draggedDocumentId: string, targetDocumentId: string) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (candidate: RelationCandidate) => void;
}) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const handleRef = React.useRef<HTMLButtonElement>(null);
  const [{ isDragging }, drag, preview] = useDrag(
    () => ({
      type: 'entity-ordered-coupon',
      canDrag: reorderable,
      item: { documentId: candidate.documentId },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [candidate.documentId, reorderable],
  );
  const [, drop] = useDrop(
    () => ({
      accept: 'entity-ordered-coupon',
      drop: (item: { documentId: string }) => {
        if (item.documentId !== candidate.documentId) {
          onDrop(item.documentId, candidate.documentId);
        }
      },
    }),
    [candidate.documentId, onDrop],
  );
  drag(handleRef);
  drop(preview(rowRef));

  return (
    <div ref={rowRef} style={{ opacity: isDragging ? 0.55 : 1 }}>
      {/*
        Styled to match the design-system `Tag` (primary100 fill, primary200
        border, bold `pi` label in primary600, 3/1 padding) without using it:
        Tag is `inline` with a fixed 3.2rem height and no wrapping, so a long
        name — "Airtel Payments Bank" — overflows this narrow sidebar instead
        of wrapping. Keeping a full-width block preserves `overflowWrap`, and
        centring the row lines the remove button up with a single-line label.
      */}
      <Box
        hasRadius
        background="primary100"
        borderColor="primary200"
        paddingLeft={reorderable ? 1 : 3}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        width="100%"
      >
        <Flex alignItems="center" gap={1} width="100%">
          {reorderable ? (
            <IconButton
              ref={handleRef}
              type="button"
              label={`Drag to reorder ${candidate.name}`}
              variant="ghost"
              size="S"
              style={{
                cursor: isDragging ? 'grabbing' : 'grab',
                touchAction: 'none',
              }}
            >
              <Drag />
            </IconButton>
          ) : null}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="pi"
              fontWeight="bold"
              textColor="primary600"
              style={{
                display: 'block',
                lineHeight: 1.35,
                overflowWrap: 'anywhere',
              }}
            >
              {reorderable ? `${index + 1}. ` : ''}
              {candidate.name}
            </Typography>
          </Box>
          {reorderable ? (
            <>
              <IconButton
                type="button"
                label={`Move ${candidate.name} up`}
                variant="ghost"
                size="S"
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
              >
                <ArrowUp />
              </IconButton>
              <IconButton
                type="button"
                label={`Move ${candidate.name} down`}
                variant="ghost"
                size="S"
                disabled={index === count - 1}
                onClick={() => onMove(index, index + 1)}
              >
                <ArrowDown />
              </IconButton>
            </>
          ) : null}
          <IconButton
            type="button"
            label={`Remove ${candidate.name}`}
            variant="ghost"
            size="S"
            disabled={removeDisabled}
            onClick={() => onRemove(candidate)}
            style={{ flexShrink: 0 }}
          >
            <Cross />
          </IconButton>
        </Flex>
      </Box>
    </div>
  );
}
