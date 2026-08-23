import * as React from 'react';
import { Box, Flex, IconButton, Typography } from '@strapi/design-system';
import { Cross } from '@strapi/icons';

import { type RelationCandidate as Candidate } from '../../../utils/single-relation';

export function SelectedRelationRow({
  candidate,
  removeDisabled,
  onRemove,
}: {
  candidate: Candidate;
  removeDisabled: boolean;
  onRemove: (candidate: Candidate) => void;
}) {
  return (
    <Box
      hasRadius
      background="primary100"
      borderColor="primary200"
      paddingLeft={3}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      width="100%"
    >
      <Flex alignItems="center" gap={1} width="100%">
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
            {candidate.name}
          </Typography>
        </Box>
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
  );
}
