import * as React from 'react';
import { useFetchClient } from '@strapi/strapi/admin';
import { Box, Button, Flex, Typography } from '@strapi/design-system';

import { removalNeedsDisconnect } from '../../../utils/ordered-relation';
import {
  getRelationDocumentId,
  isRelationFormValue,
  singleRelationChange,
  toRelationCommand,
  type RelationCandidate as Candidate,
} from '../../../utils/single-relation';
import { type RelationConfig, type SelectedRelationState } from '../config';
import { usePersistedSelection } from '../hooks/use-persisted-selection';
import { useCandidateSearch } from '../hooks/use-candidate-search';
import { CandidateList } from './candidate-list';
import { SelectedRelationRow } from './selected-relation-row';

// Orchestration for one relation section: persisted-selection/form-diff
// state lives in ../hooks/use-persisted-selection, candidate search and
// pagination in ../hooks/use-candidate-search, and the search/list controls
// in ./candidate-list. This component keeps the change handlers (single
// replacement, multi toggle, removal) and the notice/selected-row shell.
export function RelationSection({
  config,
  deferred,
  model,
  documentId,
  selectionDisabled = false,
  selectionDisabledHint,
  extraCandidateFilters,
  onSelectedState,
}: {
  config: RelationConfig;
  deferred: boolean;
  model: string;
  documentId?: string;
  /**
   * Blocks NEW selections only (radios/unchecked boxes disabled, select
   * handlers no-op). Removal stays enabled on purpose: a row that violates an
   * invariant server-side (e.g. a legacy affiliate offer with a Store) must be
   * cleanable from the panel, or the strict validator strands the editor.
   */
  selectionDisabled?: boolean;
  selectionDisabledHint?: string;
  /** Extra query params for the candidate fetch, e.g. an affiliate filter. */
  extraCandidateFilters?: Readonly<Record<string, string>>;
  onSelectedState?: (field: string, state: SelectedRelationState) => void;
}) {
  const { get } = useFetchClient();

  // Key the filters by VALUE so flipping the toggle resets pagination and
  // refetches page 1 even if a caller passes a fresh object every render.
  const extraFilterKey = JSON.stringify(extraCandidateFilters ?? null);
  const stableExtraFilters = React.useMemo<Record<string, string> | null>(
    () => JSON.parse(extraFilterKey),
    [extraFilterKey],
  );

  const {
    formValue,
    onChangeForm,
    selectedList,
    setSelectedList,
    selectedDocIds,
    selectedRelationsReady,
    relationLoadError,
    setRelationLoadAttempt,
    persistedDocumentIdsRef,
  } = usePersistedSelection({
    config,
    model,
    documentId,
    deferred,
    get,
    onSelectedState,
  });

  const {
    candidates,
    loading,
    initialLoaded,
    search,
    setSearch,
    debouncedSearch,
    sentinelRef,
  } = useCandidateSearch({
    config,
    deferred,
    documentId,
    stableExtraFilters,
    get,
  });

  const isSingleChoice = config.maxSelections === 1;

  const applySingleRelationChange = (
    change:
      | { type: 'select'; candidate: Candidate }
      | { type: 'remove'; candidate: Candidate },
  ) => {
    const persistedDocumentIds = persistedDocumentIdsRef.current;
    if (!selectedRelationsReady || !persistedDocumentIds) return;
    if (change.type === 'select' && selectionDisabled) return;

    const result = singleRelationChange({
      change,
      selected: selectedList,
      persistedDocumentIds,
      formValue: isRelationFormValue(formValue) ? formValue : {},
      // Un-defaulted on purpose: a config that omits minSelections gets the
      // util's FAIL-SAFE default (1 — the last selection cannot be removed),
      // not a silent 0 that would make every future single relation
      // emptiable. Store sets 0 explicitly where emptiable is intended.
      minSelections: config.minSelections,
    });
    if (!result) return;

    setSelectedList(result.selected);
    onChangeForm(config.field, result.formValue);
  };

  const toggle = (c: Candidate) => {
    // The persisted baseline must be loaded before any diff is computed.
    // Without this, ticking an already-persisted relation (rendered
    // unchecked while the baseline still loads) and unticking it again
    // would skip its disconnect command — the save would silently keep a
    // relation the panel showed as removed. Mirrors the guard in
    // applySingleRelationChange; for new entries the baseline is an empty
    // set and this never blocks.
    if (!selectedRelationsReady || !persistedDocumentIdsRef.current) return;
    const exists = selectedList.some((s) => s.documentId === c.documentId);
    if (!exists && selectionDisabled) return;
    if (
      !exists &&
      config.maxSelections != null &&
      selectedList.length >= config.maxSelections
    ) {
      return;
    }
    const next = exists
      ? selectedList.filter((s) => s.documentId !== c.documentId)
      : [...selectedList, c];
    const currentValue = isRelationFormValue(formValue) ? formValue : {};
    const currentConnect = currentValue.connect ?? [];
    const currentDisconnect = currentValue.disconnect ?? [];

    setSelectedList(next);

    if (exists) {
      const hasExplicitTemporaryConnect = currentConnect.some(
        (relation) =>
          getRelationDocumentId(relation) === c.documentId &&
          relation.apiData?.isTemporary === true,
      );
      const needsDisconnect = removalNeedsDisconnect(
        persistedDocumentIdsRef.current,
        c.documentId,
        hasExplicitTemporaryConnect,
      );

      onChangeForm(config.field, {
        connect: currentConnect.filter(
          (relation) => getRelationDocumentId(relation) !== c.documentId
        ),
        disconnect: needsDisconnect
          ? [
              ...currentDisconnect.filter(
                (relation) => getRelationDocumentId(relation) !== c.documentId
              ),
              toRelationCommand(c),
            ]
          : currentDisconnect,
      });

      return;
    }

    const wasPendingDisconnect = currentDisconnect.some(
      (relation) => getRelationDocumentId(relation) === c.documentId
    );

    onChangeForm(config.field, {
      connect: wasPendingDisconnect
        ? currentConnect.filter(
            (relation) => getRelationDocumentId(relation) !== c.documentId
          )
        : [
            ...currentConnect.filter(
              (relation) => getRelationDocumentId(relation) !== c.documentId
            ),
            toRelationCommand(c, { isTemporary: true }),
          ],
      disconnect: currentDisconnect.filter(
        (relation) => getRelationDocumentId(relation) !== c.documentId
      ),
    });
  };

  const removeSelection = (candidate: Candidate) => {
    if (isSingleChoice) {
      applySingleRelationChange({ type: 'remove', candidate });
      return;
    }
    toggle(candidate);
  };

  const atSelectionLimit =
    config.maxSelections != null &&
    selectedList.length >= config.maxSelections;
  const hasLegacySingleChoiceSelection =
    isSingleChoice && selectedList.length > 1;

  return (
    <Box paddingTop={3} paddingBottom={3} width="100%">
      <Flex justifyContent="space-between" alignItems="center" paddingBottom={2}>
        <Typography variant="sigma" textColor="neutral600">
          {config.label} ({selectedList.length}
          {config.maxSelections != null ? `/${config.maxSelections}` : ''})
        </Typography>
      </Flex>

      {relationLoadError && !selectedRelationsReady ? (
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
              onClick={() => setRelationLoadAttempt((attempt) => attempt + 1)}
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
            This legacy entry has {selectedList.length} selections. Choose one{' '}
            {config.singularLabel} below, or remove selections until one remains,
            before saving.
          </Typography>
        </Box>
      ) : null}

      {isSingleChoice &&
      (config.minSelections ?? 0) > 0 &&
      selectedRelationsReady &&
      selectedList.length === 0 ? (
        <Box paddingBottom={2} width="100%">
          <Typography variant="pi" textColor="danger600">
            Select exactly one {config.singularLabel} before saving.
          </Typography>
        </Box>
      ) : null}

      {selectionDisabled && selectionDisabledHint ? (
        <Box paddingBottom={2} width="100%">
          <Typography variant="pi" textColor="neutral600">
            {selectionDisabledHint}
          </Typography>
        </Box>
      ) : null}

      {selectedList.length > 0 ? (
        <Box paddingBottom={2} width="100%">
          <Flex direction="column" alignItems="stretch" gap={2} width="100%">
            {/*
              Styled to match the design-system `Tag` (primary100 fill,
              primary200 border, bold `pi` label in primary600, 3/1 padding)
              without using it: Tag is `inline` with a fixed 3.2rem height and
              no wrapping, so a long name — "Airtel Payments Bank" — overflows
              this narrow sidebar instead of wrapping. Keeping a full-width
              block preserves `overflowWrap`, and centring the row lines the
              remove button up with a single-line label.
            */}
            {selectedList.map((candidate) => (
              <SelectedRelationRow
                key={candidate.documentId}
                candidate={candidate}
                removeDisabled={
                  isSingleChoice &&
                  (!selectedRelationsReady ||
                    selectedList.length <= (config.minSelections ?? 0))
                }
                onRemove={removeSelection}
              />
            ))}
          </Flex>
        </Box>
      ) : null}

      <CandidateList
        config={config}
        isSingleChoice={isSingleChoice}
        candidates={candidates}
        selectedList={selectedList}
        selectedDocIds={selectedDocIds}
        selectedRelationsReady={selectedRelationsReady}
        selectionDisabled={selectionDisabled}
        atSelectionLimit={atSelectionLimit}
        initialLoaded={initialLoaded}
        loading={loading}
        search={search}
        setSearch={setSearch}
        debouncedSearch={debouncedSearch}
        sentinelRef={sentinelRef}
        onApplySingle={applySingleRelationChange}
        onToggle={toggle}
      />
    </Box>
  );
}
