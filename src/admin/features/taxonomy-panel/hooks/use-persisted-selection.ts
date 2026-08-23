import * as React from 'react';
import { useForm } from '@strapi/strapi/admin';

import { mergeDescendingRelationPage } from '../../../utils/ordered-relation';
import {
  getRelationDocumentId,
  isRelationFormValue,
  type RelationCandidate as Candidate,
} from '../../../utils/single-relation';
import { type RelationConfig, type SelectedRelationState } from '../config';

// Persisted-selection + form-diff state for one relation section: the
// paginated persisted-relations baseline, the pending connect/disconnect
// replay on top of it, readiness/error/retry state, and the selected-state
// report to PanelBody. Extracted verbatim from relation-section.tsx; the
// orchestrator keeps the change handlers that consume what this hook owns.
export function usePersistedSelection({
  config,
  model,
  documentId,
  deferred,
  get,
  onSelectedState,
}: {
  config: RelationConfig;
  model: string;
  documentId?: string;
  deferred: boolean;
  get: (url: string) => Promise<any>;
  onSelectedState?: (field: string, state: SelectedRelationState) => void;
}) {
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

  return {
    formValue,
    onChangeForm,
    selectedList,
    setSelectedList,
    selectedDocIds,
    selectedRelationsReady,
    relationLoadError,
    setRelationLoadAttempt,
    persistedDocumentIdsRef,
  };
}
