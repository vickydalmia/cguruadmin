import * as React from 'react';
import {
  Box,
  Checkbox,
  Flex,
  Loader,
  Radio,
  TextInput,
  Typography,
} from '@strapi/design-system';

import { type RelationCandidate as Candidate } from '../../../utils/single-relation';
import { type RelationConfig } from '../config';

// The candidate controls for one relation section: the debounced search
// input plus the scrollable radio (single-choice) or checkbox list.
// Extracted verbatim from relation-section.tsx, which keeps the change
// handlers and passes them down.
export function CandidateList({
  config,
  isSingleChoice,
  candidates,
  selectedList,
  selectedDocIds,
  selectedRelationsReady,
  selectionDisabled,
  atSelectionLimit,
  initialLoaded,
  loading,
  search,
  setSearch,
  debouncedSearch,
  sentinelRef,
  onApplySingle,
  onToggle,
}: {
  config: RelationConfig;
  isSingleChoice: boolean;
  candidates: Candidate[];
  selectedList: Candidate[];
  selectedDocIds: Set<string>;
  selectedRelationsReady: boolean;
  selectionDisabled: boolean;
  atSelectionLimit: boolean;
  initialLoaded: boolean;
  loading: boolean;
  search: string;
  setSearch: (value: string) => void;
  debouncedSearch: string;
  sentinelRef: React.RefObject<HTMLDivElement>;
  onApplySingle: (change: { type: 'select'; candidate: Candidate }) => void;
  onToggle: (candidate: Candidate) => void;
}) {
  return (
    <>
      <Box paddingBottom={2} width="100%">
        <TextInput
          aria-label={`Search ${config.label}`}
          placeholder={`Search ${config.label.toLowerCase()}...`}
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setSearch(e.target.value)
          }
          size="S"
        />
      </Box>

      <Box
        hasRadius
        background="neutral0"
        borderColor="neutral200"
        padding={2}
        width="100%"
        style={{ maxHeight: 220, overflowY: 'auto', boxSizing: 'border-box' }}
      >
        {isSingleChoice ? (
          <Radio.Group
            name={`${config.field}-single-selection`}
            value={
              selectedList.length === 1
                ? selectedList[0]?.documentId
                : undefined
            }
            onValueChange={(documentId: string) => {
              const candidate = candidates.find(
                (item) => item.documentId === documentId,
              );
              if (candidate) {
                onApplySingle({
                  type: 'select',
                  candidate,
                });
              }
            }}
          >
            <Flex direction="column" alignItems="stretch" gap={1}>
              {candidates.map((candidate) => (
                <Radio.Item
                  key={candidate.documentId}
                  value={candidate.documentId}
                  disabled={!selectedRelationsReady || selectionDisabled}
                >
                  {candidate.name}
                </Radio.Item>
              ))}
            </Flex>
          </Radio.Group>
        ) : (
          candidates.map((c) => (
            <Box key={c.documentId} paddingBottom={1}>
              <Checkbox
                checked={selectedDocIds.has(c.documentId)}
                disabled={
                  // Same not-ready gate as the Radio list: until the
                  // persisted baseline loads, any toggle would diff
                  // against an empty selection.
                  !selectedRelationsReady ||
                  (!selectedDocIds.has(c.documentId) &&
                    (atSelectionLimit || selectionDisabled))
                }
                onCheckedChange={() => onToggle(c)}
              >
                {c.name}
              </Checkbox>
            </Box>
          ))
        )}

        {initialLoaded && candidates.length === 0 ? (
          <Typography variant="pi" textColor="neutral500">
            {debouncedSearch
              ? 'No matches.'
              : `No ${config.label.toLowerCase()} available.`}
          </Typography>
        ) : null}

        {loading ? (
          <Flex justifyContent="center" padding={2}>
            <Loader small>Loading</Loader>
          </Flex>
        ) : null}

        <div ref={sentinelRef} style={{ height: 1 }} />
      </Box>
    </>
  );
}
