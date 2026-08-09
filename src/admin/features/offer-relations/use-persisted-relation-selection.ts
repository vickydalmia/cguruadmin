import { useFetchClient, useForm } from '@strapi/strapi/admin';
import * as React from 'react';

import {
  brandCandidateBlocked,
  storeAddBlocked,
} from '../../utils/affiliate-exclusion';
import {
  mergeDescendingRelationPage,
  orderedRelationCommands,
  removalNeedsDisconnect,
} from '../../utils/ordered-relation';
import {
  getRelationDocumentId,
  isRelationFormValue,
  singleRelationChange,
  toRelationCommand,
  type RelationCandidate,
} from '../../utils/single-relation';
import type { AffiliateContext, RelationConfig, SelectionReport } from './types';

type SelectionChange =
  | { type: 'select'; candidate: RelationCandidate }
  | { type: 'remove'; candidate: RelationCandidate };

export function usePersistedRelationSelection({
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
  const { get } = useFetchClient();
  const formValue = useForm(
    'RelationSection',
    (state) => state.values?.[config.field],
  );
  const onChangeForm = useForm('RelationSection', (state) => state.onChange);

  const relationLoadKey = `${documentId ?? 'new'}:${config.field}`;
  const [selectedList, setSelectedList] = React.useState<RelationCandidate[]>([]);
  const [loadedRelationKey, setLoadedRelationKey] = React.useState<string | null>(
    documentId ? null : relationLoadKey,
  );
  const selectedRelationsReady = loadedRelationKey === relationLoadKey;
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
      if (!documentId) setLoadedRelationKey(relationLoadKey);
      if (formValue.length === 0) {
        setSelectedList([]);
        return;
      }
      setSelectedList(
        formValue.map((value: any) => ({
          id: value.id,
          documentId: value.documentId,
          name: value.name ?? value.title ?? String(value.id),
        })),
      );
      return;
    }

    if (isRelationFormValue(formValue)) {
      setSelectedList((current) => {
        const disconnectDocIds = new Set(
          (formValue.disconnect ?? [])
            .map((relation) => getRelationDocumentId(relation))
            .filter((docId): docId is string => Boolean(docId)),
        );
        const next = current.filter(
          (relation) => !disconnectDocIds.has(relation.documentId),
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
        const all: RelationCandidate[] = [];
        for (let page = 1; page <= 50; page++) {
          const response = await get(
            `/content-manager/relations/${model}/${documentId}/${config.field}?page=${page}&pageSize=100`,
          );
          const body = response?.data?.data ?? response?.data;
          const results: any[] = body?.results ?? [];
          const pageCandidates = results.map((row: any) => ({
            id: row.id,
            documentId: row.documentId,
            name: row.name ?? row.title ?? String(row.id),
          }));
          const merged = mergeDescendingRelationPage(all, pageCandidates);
          all.splice(0, all.length, ...merged);
          const pageCount = body?.pagination?.pageCount ?? 1;
          if (page >= pageCount || results.length === 0) break;
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
              .filter((docId): docId is string => Boolean(docId)),
          );
          const next = all.filter(
            (relation) => !disconnectDocIds.has(relation.documentId),
          );
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
      } catch (error) {
        console.error(
          `[taxonomy-panel] Failed to load selected ${config.field}`,
          error,
        );
        if (!cancelled) setRelationLoadError(true);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [
    deferred,
    documentId,
    model,
    config.field,
    get,
    relationLoadKey,
    relationLoadAttempt,
  ]);

  const selectedDocIds = React.useMemo(
    () => new Set(selectedList.map((selection) => selection.documentId)),
    [selectedList],
  );

  React.useEffect(() => {
    if (!config.affiliateRule || !reportSelection) return;
    reportSelection(config.field, {
      entries: selectedList.map((candidate) => ({
        documentId: candidate.documentId,
        name: candidate.name,
        ...(candidate.isAffiliate !== undefined
          ? { isAffiliate: candidate.isAffiliate }
          : {}),
      })),
      ready: selectedRelationsReady,
    });
  }, [
    config.affiliateRule,
    config.field,
    reportSelection,
    selectedList,
    selectedRelationsReady,
  ]);

  const isSingleChoice = config.maxSelections === 1;

  const applySingleRelationChange = (change: SelectionChange) => {
    const persistedDocumentIds = persistedDocumentIdsRef.current;
    if (!selectedRelationsReady || !persistedDocumentIds) return;
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

  const affiliateAddBlocked = (candidate: RelationCandidate): boolean => {
    const context = affiliateContext;
    if (!context || !config.affiliateRule) return false;
    const isSelected = selectedDocIds.has(candidate.documentId);
    if (config.affiliateRule === 'brands') {
      return brandCandidateBlocked({
        isSelected,
        isAffiliate: candidate.isAffiliate,
        storeCount: context.storeCount,
        storesReady: context.storesReady,
        selectedBrandCount: selectedList.length,
        brandsReady: selectedRelationsReady,
        affiliateFlagsReady: context.affiliateFlagsReady,
        affiliateSelectedCount: context.affiliateSelectedDocIds.size,
        merchant: context.merchant,
        candidateDocumentId: candidate.documentId,
      });
    }
    return (
      !isSelected &&
      storeAddBlocked({
        brandsReady: context.brandsReady,
        affiliateFlagsReady: context.affiliateFlagsReady,
        affiliateSelectedCount: context.affiliateSelectedDocIds.size,
      })
    );
  };

  const toggle = (candidate: RelationCandidate) => {
    const exists = selectedList.some(
      (selection) => selection.documentId === candidate.documentId,
    );
    if (!exists && affiliateAddBlocked(candidate)) return;
    if (
      !exists &&
      config.maxSelections != null &&
      selectedList.length >= config.maxSelections
    ) {
      return;
    }
    const next = exists
      ? selectedList.filter(
          (selection) => selection.documentId !== candidate.documentId,
        )
      : [...selectedList, candidate];
    const currentValue = isRelationFormValue(formValue) ? formValue : {};
    const currentConnect = currentValue.connect ?? [];
    const currentDisconnect = currentValue.disconnect ?? [];
    setSelectedList(next);

    if (exists) {
      const hasExplicitTemporaryConnect = currentConnect.some(
        (relation) =>
          getRelationDocumentId(relation) === candidate.documentId &&
          relation.apiData?.isTemporary === true,
      );
      const needsDisconnect = removalNeedsDisconnect(
        persistedDocumentIdsRef.current,
        candidate.documentId,
        hasExplicitTemporaryConnect,
      );
      onChangeForm(config.field, {
        connect: config.reorderable
          ? orderedRelationCommands(next)
          : currentConnect.filter(
              (relation) =>
                getRelationDocumentId(relation) !== candidate.documentId,
            ),
        disconnect: needsDisconnect
          ? [
              ...currentDisconnect.filter(
                (relation) =>
                  getRelationDocumentId(relation) !== candidate.documentId,
              ),
              toRelationCommand(candidate),
            ]
          : currentDisconnect,
      });
      return;
    }

    const wasPendingDisconnect = currentDisconnect.some(
      (relation) => getRelationDocumentId(relation) === candidate.documentId,
    );
    onChangeForm(config.field, {
      connect: config.reorderable
        ? orderedRelationCommands(next)
        : wasPendingDisconnect
          ? currentConnect.filter(
              (relation) =>
                getRelationDocumentId(relation) !== candidate.documentId,
            )
          : [
              ...currentConnect.filter(
                (relation) =>
                  getRelationDocumentId(relation) !== candidate.documentId,
              ),
              toRelationCommand(candidate, { isTemporary: true }),
            ],
      disconnect: currentDisconnect.filter(
        (relation) => getRelationDocumentId(relation) !== candidate.documentId,
      ),
    });
  };

  const removeSelection = (candidate: RelationCandidate) => {
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
      selectedList.findIndex(
        (item) => item.documentId === draggedDocumentId,
      ),
      selectedList.findIndex((item) => item.documentId === targetDocumentId),
    );
  };

  return {
    selectedList,
    selectedDocIds,
    selectedRelationsReady,
    relationLoadError,
    retryRelationLoad: () => setRelationLoadAttempt((attempt) => attempt + 1),
    isSingleChoice,
    affiliateAddBlocked,
    applySingleRelationChange,
    toggle,
    removeSelection,
    moveSelection,
    dropSelection,
  };
}
