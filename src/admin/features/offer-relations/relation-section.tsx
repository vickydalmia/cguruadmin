import { Box, Button, Flex, Typography } from '@strapi/design-system';
import * as React from 'react';

import {
  affiliateBlockNote,
  storeBlockNote,
} from '../../utils/affiliate-exclusion';
import { RelationCandidateList } from './relation-candidate-list';
import { SelectedRelationRow } from './selected-relation-row';
import type { AffiliateContext, RelationConfig, SelectionReport } from './types';
import { usePersistedRelationSelection } from './use-persisted-relation-selection';
import { useRelationCandidates } from './use-relation-candidates';

export function RelationSection({
  config,
  deferred,
  model,
  documentId,
  affiliateContext,
  reportSelection,
}: {
  config: RelationConfig;
  deferred: boolean;
  model: string;
  documentId?: string;
  affiliateContext?: AffiliateContext | null;
  reportSelection?: (field: string, report: SelectionReport) => void;
}) {
  const selection = usePersistedRelationSelection({
    config,
    deferred,
    model,
    documentId,
    affiliateContext,
    reportSelection,
  });
  const candidateState = useRelationCandidates({
    config,
    deferred,
    documentId,
  });
  const requiresSavedEntity = Boolean(
    config.scopeRelationField && !documentId,
  );
  const atSelectionLimit =
    config.maxSelections != null &&
    selection.selectedList.length >= config.maxSelections;
  const scopeEntityLabel = config.scopeRelationField
    ? {
        stores: 'Store',
        brands: 'Brand',
        categories: 'Category',
        banks: 'Bank',
      }[config.scopeRelationField]
    : null;
  const hasLegacySingleChoiceSelection =
    selection.isSingleChoice && selection.selectedList.length > 1;

  const affiliateNote = React.useMemo((): string | null => {
    if (!affiliateContext || !config.affiliateRule) return null;
    if (config.affiliateRule === 'stores') {
      return storeBlockNote({
        affiliateSelectedNames: affiliateContext.affiliateSelectedNames,
      });
    }
    const blockedAffiliateVisible = candidateState.candidates.some(
      (candidate) =>
        candidate.isAffiliate === true &&
        !selection.selectedDocIds.has(candidate.documentId),
    );
    if (
      affiliateContext.affiliateSelectedNames.length === 0 &&
      !blockedAffiliateVisible
    ) {
      return null;
    }
    return affiliateBlockNote({
      storeCount: affiliateContext.storeCount,
      selectedBrandCount: selection.selectedList.length,
      affiliateSelectedNames: affiliateContext.affiliateSelectedNames,
    });
  }, [
    affiliateContext,
    config.affiliateRule,
    candidateState.candidates,
    selection.selectedDocIds,
    selection.selectedList,
  ]);

  return (
    <Box paddingTop={3} paddingBottom={3} width="100%">
      <Flex justifyContent="space-between" alignItems="center" paddingBottom={2}>
        <Typography variant="sigma" textColor="neutral600">
          {config.label} ({selection.selectedList.length}
          {config.maxSelections != null ? `/${config.maxSelections}` : ''})
        </Typography>
      </Flex>

      {selection.relationLoadError && !selection.selectedRelationsReady ? (
        <Box
          hasRadius
          background="danger100"
          borderColor="danger200"
          padding={2}
          marginBottom={2}
        >
          <Flex direction="column" alignItems="flex-start" gap={1}>
            <Typography variant="pi" textColor="danger600">
              Could not load the saved {config.label}. The controls stay
              disabled so a save cannot run against an incomplete selection.
            </Typography>
            <Button
              variant="danger-light"
              size="S"
              onClick={selection.retryRelationLoad}
            >
              Retry
            </Button>
          </Flex>
        </Box>
      ) : null}

      {hasLegacySingleChoiceSelection ? (
        <Box
          hasRadius
          background="warning100"
          borderColor="warning200"
          padding={2}
          marginBottom={2}
        >
          <Typography variant="pi" textColor="warning600">
            This legacy entry has {selection.selectedList.length} Stores. Choose
            one Store below, or remove Stores until one remains, before saving.
          </Typography>
        </Box>
      ) : null}

      {affiliateNote ? (
        <Box
          hasRadius
          background="warning100"
          borderColor="warning200"
          padding={2}
          marginBottom={2}
        >
          <Typography variant="pi" textColor="warning600">
            {affiliateNote}
          </Typography>
        </Box>
      ) : null}

      {selection.isSingleChoice &&
      (config.minSelections ?? 0) > 0 &&
      selection.selectedRelationsReady &&
      selection.selectedList.length === 0 ? (
        <Box paddingBottom={2} width="100%">
          <Typography variant="pi" textColor="danger600">
            Select exactly one Store before saving.
          </Typography>
        </Box>
      ) : null}

      {scopeEntityLabel && documentId ? (
        <Box paddingBottom={3} width="100%">
          <Typography variant="pi" textColor="neutral600">
            Only live Coupons related to this {scopeEntityLabel} are listed.{' '}
            {config.description}
          </Typography>
        </Box>
      ) : null}

      {selection.selectedList.length > 0 ? (
        <Box paddingBottom={2} width="100%">
          <Flex direction="column" alignItems="stretch" gap={2} width="100%">
            {selection.selectedList.map((candidate, index) => (
              <SelectedRelationRow
                key={candidate.documentId}
                candidate={candidate}
                index={index}
                count={selection.selectedList.length}
                reorderable={Boolean(config.reorderable)}
                removeDisabled={
                  selection.isSingleChoice &&
                  (!selection.selectedRelationsReady ||
                    selection.selectedList.length <= (config.minSelections ?? 0))
                }
                onDrop={selection.dropSelection}
                onMove={selection.moveSelection}
                onRemove={selection.removeSelection}
              />
            ))}
          </Flex>
        </Box>
      ) : null}

      {requiresSavedEntity ? (
        <Box paddingTop={1} paddingBottom={1} width="100%">
          <Typography variant="pi" textColor="neutral600">
            Save this entry first. Its related Coupons will then be available
            here.
          </Typography>
        </Box>
      ) : (
        <RelationCandidateList
          config={config}
          candidates={candidateState.candidates}
          selectedDocIds={selection.selectedDocIds}
          selectedList={selection.selectedList}
          selectedRelationsReady={selection.selectedRelationsReady}
          atSelectionLimit={atSelectionLimit}
          loading={candidateState.loading}
          initialLoaded={candidateState.initialLoaded}
          loadError={candidateState.loadError}
          retryCandidates={candidateState.retryCandidates}
          search={candidateState.search}
          setSearch={candidateState.setSearch}
          debouncedSearch={candidateState.debouncedSearch}
          sentinelRef={candidateState.sentinelRef}
          affiliateAddBlocked={selection.affiliateAddBlocked}
          applySingleRelationChange={selection.applySingleRelationChange}
          toggle={selection.toggle}
        />
      )}
    </Box>
  );
}
