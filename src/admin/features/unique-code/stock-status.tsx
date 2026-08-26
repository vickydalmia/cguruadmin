// STOCK STATUS presentation for the unique-code import: the pool-level
// banner and its tone rules. An empty pool EXPIRES every offer drawing from
// it, so stock is a status, not a footnote.
import * as React from 'react';
import { Box, Flex, Typography } from '@strapi/design-system';

/**
 * Warn while there is still time to act. An empty pool now EXPIRES every
 * coupon that draws from it (the scheduler flips contentStatus within five
 * minutes), so running dry silently takes offers off the site.
 */
const LOW_STOCK_THRESHOLD = 50;

export type PoolStats = {
  totalCodes: number;
  usedCodes: number;
  availableCodes: number;
};

type StockTone = {
  text: string;
  background: string;
  border: string;
  note: string | null;
};

/**
 * An empty pool now EXPIRES every offer drawing from it, so stock is a status,
 * not a footnote — it gets design-system colour rather than grey body text.
 */
function stockTone(stats: PoolStats): StockTone {
  if (stats.availableCodes === 0) {
    return {
      text: 'danger600',
      background: 'danger100',
      border: 'danger200',
      note: 'This pool is empty — every offer using it stays expired until you import more codes.',
    };
  }
  if (stats.availableCodes <= LOW_STOCK_THRESHOLD) {
    return {
      text: 'warning600',
      background: 'warning100',
      border: 'warning200',
      note: 'Running low — import more before it empties.',
    };
  }
  return {
    text: 'neutral700',
    background: 'neutral100',
    border: 'neutral200',
    note: null,
  };
}

export function StockStatusBanner({ stats }: { stats: PoolStats }) {
  const tone = stockTone(stats);
  return (
    <Box
      padding={3}
      hasRadius
      background={tone.background}
      borderColor={tone.border}
    >
      <Flex direction="column" alignItems="start" gap={1}>
        <Typography variant="pi" fontWeight="bold" textColor={tone.text}>
          {stats.availableCodes.toLocaleString()} unused of{' '}
          {stats.totalCodes.toLocaleString()}
        </Typography>
        {tone.note ? (
          <Typography variant="pi" textColor={tone.text}>
            {tone.note}
          </Typography>
        ) : null}
      </Flex>
    </Box>
  );
}
