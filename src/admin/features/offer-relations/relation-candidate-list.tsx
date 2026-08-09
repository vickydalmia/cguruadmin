import {
  Box,
  Button,
  Checkbox,
  Flex,
  Loader,
  Radio,
  TextInput,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';

import type { RelationCandidate } from '../../utils/single-relation';
import type { RelationConfig } from './types';

export function RelationCandidateList({
  config,
  candidates,
  selectedDocIds,
  selectedList,
  selectedRelationsReady,
  atSelectionLimit,
  loading,
  initialLoaded,
  loadError,
  retryCandidates,
  search,
  setSearch,
  debouncedSearch,
  sentinelRef,
  affiliateAddBlocked,
  applySingleRelationChange,
  toggle,
}: {
  config: RelationConfig;
  candidates: RelationCandidate[];
  selectedDocIds: ReadonlySet<string>;
  selectedList: RelationCandidate[];
  selectedRelationsReady: boolean;
  atSelectionLimit: boolean;
  loading: boolean;
  initialLoaded: boolean;
  loadError: boolean;
  retryCandidates: () => void;
  search: string;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  debouncedSearch: string;
  sentinelRef: React.RefObject<HTMLDivElement>;
  affiliateAddBlocked: (candidate: RelationCandidate) => boolean;
  applySingleRelationChange: (change: {
    type: 'select';
    candidate: RelationCandidate;
  }) => void;
  toggle: (candidate: RelationCandidate) => void;
}) {
  const isSingleChoice = config.maxSelections === 1;

  return (
    <>
      <Box paddingBottom={2} width="100%">
        <TextInput
          aria-label={`Search ${config.label}`}
          placeholder={`Search ${config.label.toLowerCase()}...`}
          value={search}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setSearch(event.target.value)
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
              if (candidate && !affiliateAddBlocked(candidate)) {
                applySingleRelationChange({ type: 'select', candidate });
              }
            }}
          >
            <Flex direction="column" alignItems="stretch" gap={1}>
              {candidates.map((candidate) => (
                <Radio.Item
                  key={candidate.documentId}
                  value={candidate.documentId}
                  disabled={
                    !selectedRelationsReady || affiliateAddBlocked(candidate)
                  }
                >
                  {candidate.name}
                </Radio.Item>
              ))}
            </Flex>
          </Radio.Group>
        ) : (
          candidates.map((candidate) => (
            <Box key={candidate.documentId} paddingBottom={1}>
              <Checkbox
                checked={selectedDocIds.has(candidate.documentId)}
                disabled={
                  (!selectedDocIds.has(candidate.documentId) &&
                    atSelectionLimit) ||
                  affiliateAddBlocked(candidate)
                }
                onCheckedChange={() => toggle(candidate)}
              >
                {candidate.isAffiliate === true
                  ? `${candidate.name} — affiliate`
                  : candidate.name}
              </Checkbox>
            </Box>
          ))
        )}

        {loadError && !loading ? (
          <Flex direction="column" alignItems="flex-start" gap={1}>
            <Typography variant="pi" textColor="danger600">
              Could not load {config.label.toLowerCase()} to pick from.
            </Typography>
            <Button variant="danger-light" size="S" onClick={retryCandidates}>
              Retry
            </Button>
          </Flex>
        ) : null}

        {!loadError && initialLoaded && candidates.length === 0 ? (
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
