import * as React from 'react';
import { useFetchClient, useForm } from '@strapi/strapi/admin';
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

import {
  mergeDescendingRelationPage,
  orderedRelationCommands,
  removalNeedsDisconnect,
} from '../../../utils/ordered-relation';
import {
  getRelationDocumentId,
  isRelationFormValue,
  singleRelationChange,
  toRelationCommand,
  type RelationCandidate as Candidate,
} from '../../../utils/single-relation';
import { PAGE_SIZE, type RelationConfig } from '../config';
import { SelectedRelationRow } from './selected-relation-row';

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
  onSelectedState?: (
    field: string,
    state: { count: number; ready: boolean },
  ) => void;
}) {
  const { get } = useFetchClient();

  // Key the filters by VALUE so flipping the toggle resets pagination and
  // refetches page 1 even if a caller passes a fresh object every render.
  const extraFilterKey = JSON.stringify(extraCandidateFilters ?? null);
  const stableExtraFilters = React.useMemo<Record<string, string> | null>(
    () => JSON.parse(extraFilterKey),
    [extraFilterKey],
  );

  const formValue = useForm(
    'RelationSection',
    (state) => state.values?.[config.field]
  );
  const onChangeForm = useForm('RelationSection', (state) => state.onChange);

  const relationLoadKey = `${documentId ?? 'new'}:${config.field}`;
  const [selectedList, setSelectedList] = React.useState<Candidate[]>([]);
  const [loadedRelationKey, setLoadedRelationKey] = React.useState<string | null>(
    documentId ? null : relationLoadKey,
  );
  const selectedRelationsReady = loadedRelationKey === relationLoadKey;
  // A failed relations load must not silently disable the panel for the whole
  // session — surface it and let the editor retry without a full page reload.
  const [relationLoadError, setRelationLoadError] = React.useState(false);
  const [relationLoadAttempt, setRelationLoadAttempt] = React.useState(0);
  const persistedDocumentIdsRef = React.useRef<Set<string> | null>(
    documentId ? null : new Set(),
  );
  React.useEffect(() => {
    persistedDocumentIdsRef.current = documentId ? null : new Set();
    setLoadedRelationKey(documentId ? null : relationLoadKey);
    setSelectedList([]);
    setRelationLoadError(false);
  }, [documentId, config.field, relationLoadKey]);

  const formValueRef = React.useRef(formValue);
  React.useEffect(() => {
    formValueRef.current = formValue;
  }, [formValue]);

  React.useEffect(() => {
    if (Array.isArray(formValue)) {
      persistedDocumentIdsRef.current ??= new Set(
        formValue
          .map((value: any) => value?.documentId)
          .filter((value): value is string => typeof value === 'string'),
      );
      // Existing entries still wait for the dedicated paginated relations
      // endpoint below. The document payload can contain only a partial
      // relation preview; treating it as the baseline could omit a legacy
      // Store from the atomic disconnect set.
      if (!documentId) setLoadedRelationKey(relationLoadKey);
      if (formValue.length === 0) {
        setSelectedList([]);
        return;
      }
      setSelectedList(
        formValue.map((v: any) => ({
          id: v.id,
          documentId: v.documentId,
          name: v.name ?? v.title ?? String(v.id),
        }))
      );
      return;
    }

    if (isRelationFormValue(formValue)) {
      setSelectedList((current) => {
        const disconnectDocIds = new Set(
          (formValue.disconnect ?? [])
            .map((relation) => getRelationDocumentId(relation))
            .filter((docId): docId is string => Boolean(docId))
        );
        const next = current.filter(
          (relation) => !disconnectDocIds.has(relation.documentId)
        );

        for (const relation of formValue.connect ?? []) {
          const docId = getRelationDocumentId(relation);
          if (
            !docId ||
            disconnectDocIds.has(docId) ||
            next.some((item) => item.documentId === docId)
          ) {
            continue;
          }

          next.push({
            id: relation.id,
            documentId: docId,
            name: relation.name ?? String(relation.id),
          });
        }

        return next;
      });
    }
  }, [formValue, documentId, relationLoadKey]);

  React.useEffect(() => {
    if (!deferred || !documentId) return;
    let cancelled = false;
    setRelationLoadError(false);
    const run = async () => {
      try {
        const all: Candidate[] = [];
        for (let page = 1; page <= 50; page++) {
          const res = await get(
            `/content-manager/relations/${model}/${documentId}/${config.field}?page=${page}&pageSize=100`
          );
          const body = res?.data?.data ?? res?.data;
          const results: any[] = body?.results ?? [];
          const pageCandidates = results.map((r: any) => ({
              id: r.id,
              documentId: r.documentId,
              name: r.name ?? r.title ?? String(r.id),
            }));
          const merged = mergeDescendingRelationPage(all, pageCandidates);
          all.splice(0, all.length, ...merged);
          const pageCount = body?.pagination?.pageCount ?? 1;
          if (page >= pageCount || results.length === 0) break;
          if (page === 50) {
            // Hard cap reached with pages still remaining: the persisted
            // baseline would be silently incomplete, and edits computed
            // against it could drop relations without a disconnect. Fail
            // into the retryable error state instead of proceeding.
            throw new Error(
              `${config.field} has ${pageCount} pages of persisted relations — ` +
                'refusing to edit against a truncated baseline',
            );
          }
        }
        if (cancelled) return;
        persistedDocumentIdsRef.current = new Set(
          all.map((relation) => relation.documentId),
        );
        setLoadedRelationKey(relationLoadKey);
        setSelectedList(() => {
          const latest = formValueRef.current;
          if (!isRelationFormValue(latest)) return all;
          const disconnectDocIds = new Set(
            (latest.disconnect ?? [])
              .map((relation) => getRelationDocumentId(relation))
              .filter((docId): docId is string => Boolean(docId))
          );
          const next = all.filter((r) => !disconnectDocIds.has(r.documentId));
          for (const relation of latest.connect ?? []) {
            const docId = getRelationDocumentId(relation);
            if (
              !docId ||
              disconnectDocIds.has(docId) ||
              next.some((item) => item.documentId === docId)
            ) {
              continue;
            }
            next.push({
              id: relation.id,
              documentId: docId,
              name: relation.name ?? String(relation.id),
            });
          }
          return next;
        });
      } catch (err) {
        console.error(`[taxonomy-panel] Failed to load selected ${config.field}`, err);
        if (!cancelled) setRelationLoadError(true);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [deferred, documentId, model, config.field, get, relationLoadKey, relationLoadAttempt]);

  const selectedDocIds = React.useMemo(
    () => new Set(selectedList.map((s) => s.documentId)),
    [selectedList]
  );

  // Reports the live selection (persisted relations + form diff replayed) so
  // PanelBody can gate the affiliate toggle without recomputing it.
  React.useEffect(() => {
    onSelectedState?.(config.field, {
      count: selectedList.length,
      ready: selectedRelationsReady,
    });
  }, [onSelectedState, config.field, selectedList.length, selectedRelationsReady]);

  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [page, setPage] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [initialLoaded, setInitialLoaded] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    setCandidates([]);
    setPage(1);
    setPageCount(1);
    setInitialLoaded(false);
  }, [
    debouncedSearch,
    config.target,
    config.scopeRelationField,
    documentId,
    stableExtraFilters,
  ]);

  React.useEffect(() => {
    if (!deferred || (config.scopeRelationField && !documentId)) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const mainField = config.mainField ?? 'name';
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          sort: `${mainField}:ASC`,
        });
        if (debouncedSearch) {
          params.set(`filters[${mainField}][$containsi]`, debouncedSearch);
        }
        if (config.scopeRelationField && documentId) {
          params.set(
            `filters[${config.scopeRelationField}][documentId][$eq]`,
            documentId,
          );
          // An offer can pass its exact expiresAt up to five minutes before
          // the scheduler changes contentStatus. Match the public visibility
          // rule so that already-dead Coupons never appear in entity Top Pick
          // dropdowns during that window.
          params.set('filters[contentStatus][$eq]', 'published');
          params.set('filters[$or][0][expiresAt][$null]', 'true');
          params.set(
            'filters[$or][1][expiresAt][$gt]',
            new Date().toISOString(),
          );
        }
        if (stableExtraFilters) {
          for (const [key, value] of Object.entries(stableExtraFilters)) {
            params.set(key, value);
          }
        }
        const res = await get(
          `/content-manager/collection-types/${config.target}?${params.toString()}`
        );
        const body = res?.data?.data ?? res?.data;
        const results: any[] = body?.results ?? [];
        if (cancelled) return;
        const list: Candidate[] = results.map((r: any) => ({
          id: r.id,
          documentId: r.documentId,
          name: r.name ?? r.title ?? String(r.id),
        }));
        setCandidates((prev) => (page === 1 ? list : [...prev, ...list]));
        setPageCount(body?.pagination?.pageCount ?? 1);
        setInitialLoaded(true);
      } catch (err) {
        console.error(`[taxonomy-panel] Failed to load ${config.field}`, err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [
    deferred,
    page,
    debouncedSearch,
    config.target,
    config.field,
    config.mainField,
    config.scopeRelationField,
    documentId,
    stableExtraFilters,
    get,
  ]);

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
        // Rebuild every anchor from the final selection. After a prior reorder,
        // a surviving command may still point `before` the removed Coupon.
        connect: config.reorderable
          ? orderedRelationCommands(next)
          : currentConnect.filter(
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
      // Canceling a disconnect changes the final ordered selection too. The
      // shortened list's positional commands cannot be reused because they may
      // place the restored Coupon before the wrong anchor.
      connect: config.reorderable
        ? orderedRelationCommands(next)
        : wasPendingDisconnect
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

  const moveSelection = (fromIndex: number, toIndex: number) => {
    if (
      !config.reorderable ||
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= selectedList.length ||
      toIndex >= selectedList.length
    ) {
      return;
    }

    const next = [...selectedList];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    const currentValue = isRelationFormValue(formValue) ? formValue : {};

    setSelectedList(next);
    onChangeForm(config.field, {
      connect: orderedRelationCommands(next),
      disconnect: currentValue.disconnect ?? [],
    });
  };

  const dropSelection = (
    draggedDocumentId: string,
    targetDocumentId: string,
  ) => {
    moveSelection(
      selectedList.findIndex((item) => item.documentId === draggedDocumentId),
      selectedList.findIndex((item) => item.documentId === targetDocumentId),
    );
  };

  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const hasMore = page < pageCount;
  const requiresSavedEntity = Boolean(
    config.scopeRelationField && !documentId,
  );
  const atSelectionLimit =
    config.maxSelections != null &&
    selectedList.length >= config.maxSelections;
  const scopeEntityLabel = config.scopeRelationField
    ? {
        stores: 'Store',
        brands: 'Brand',
        categories: 'Category',
        banks: 'Bank',
      }[config.scopeRelationField]
    : null;
  const hasLegacySingleChoiceSelection =
    isSingleChoice && selectedList.length > 1;

  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setPage((p) => p + 1);
        }
      },
      { root: el.parentElement, rootMargin: '50px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, candidates.length]);

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
            This legacy entry has {selectedList.length} Stores. Choose one
            Store below, or remove Stores until one remains, before saving.
          </Typography>
        </Box>
      ) : null}

      {isSingleChoice &&
      (config.minSelections ?? 0) > 0 &&
      selectedRelationsReady &&
      selectedList.length === 0 ? (
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
            {selectedList.map((candidate, index) => (
              <SelectedRelationRow
                key={candidate.documentId}
                candidate={candidate}
                index={index}
                count={selectedList.length}
                reorderable={Boolean(config.reorderable)}
                removeDisabled={
                  isSingleChoice &&
                  (!selectedRelationsReady ||
                    selectedList.length <= (config.minSelections ?? 0))
                }
                onDrop={dropSelection}
                onMove={moveSelection}
                onRemove={removeSelection}
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
                    applySingleRelationChange({
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
                    onCheckedChange={() => toggle(c)}
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
      )}
    </Box>
  );
}
