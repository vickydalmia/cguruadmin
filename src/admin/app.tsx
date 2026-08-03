import Logo from './extensions/logo-icon.svg';

import type { StrapiApp } from '@strapi/strapi/admin';
import { useFetchClient, useForm, useRBAC } from '@strapi/strapi/admin';
import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { unstable_useContentManagerContext } from '@strapi/content-manager/strapi-admin';
import * as React from 'react';
import {
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  IconButton,
  Loader,
  Radio,
  TextInput,
  Typography,
} from '@strapi/design-system';
import { ArrowDown, ArrowUp, Cross, Drag, Earth } from '@strapi/icons';
import {
  useDrag,
  useDrop,
} from 'react-dnd';

import { useIntl } from 'react-intl';

import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
} from '../constants/homepage-sections';
import {
  DOTD_SECTION_LABELS,
  DOTD_UID,
} from '../constants/deal-of-the-day-sections';
import { HOMEPAGE_IMAGE_RULES } from '../constants/homepage-images';
import RichTextEditor from './components/RichTextEditor';
import DateTimeInput from './components/DateTimeInput';
import BooleanConfirmInput from './components/BooleanConfirmInput';
import PublicOfferLinkAction from './components/PublicOfferLinkAction';
import BumpToTopAction from './components/BumpToTopAction';
import OfferStatusTabs from './components/OfferStatusTabs';
import PublishingPanel from './components/PublishingPanel';
import OfferBenefitsPanel from './components/OfferBenefitsPanel';
import EntryLinkCell from './components/EntryLinkCell';
import RecordLockPanel from './components/RecordLockPanel';
import UniqueCodeImport from './components/UniqueCodeImport';
import { isLinkableCellType } from './utils/entry-link';
import {
  mergeDescendingRelationPage,
  orderedRelationCommands,
  removalNeedsDisconnect,
} from './utils/ordered-relation';
import { installRecordLockLeaseInterceptor } from './utils/record-lock-lease';
import { createDealAwareMediaInput } from './features/deal-image/components/deal-aware-media-input';
import { couponLayoutPanel } from './features/coupon-layout/components/coupon-layout-panel';
import {
  pendingRequiredFields,
  type PendingField,
} from './utils/pending-required';
import {
  getRelationDocumentId,
  isRelationFormValue,
  singleRelationChange,
  toRelationCommand,
  type RelationCandidate as Candidate,
} from './utils/single-relation';

type RelationConfig = {
  field: string;
  target: string;
  label: string;
  mainField?: 'name' | 'title';
  scopeRelationField?: 'stores' | 'brands' | 'categories' | 'banks';
  minSelections?: number;
  maxSelections?: number;
  description?: string;
  reorderable?: boolean;
};

const RELATION_CONFIG: Record<string, RelationConfig[]> = {
  'api::deal.deal': [
    {
      field: 'stores',
      target: 'api::store.store',
      label: 'Store',
      minSelections: 0,
      maxSelections: 1,
    },
    { field: 'brands', target: 'api::brand.brand', label: 'Brands' },
    { field: 'categories', target: 'api::category.category', label: 'Categories' },
    { field: 'banks', target: 'api::bank.bank', label: 'Banks' },
  ],
  'api::coupon.coupon': [
    {
      field: 'stores',
      target: 'api::store.store',
      label: 'Store',
      minSelections: 0,
      maxSelections: 1,
    },
    { field: 'brands', target: 'api::brand.brand', label: 'Brands' },
    { field: 'categories', target: 'api::category.category', label: 'Categories' },
    { field: 'banks', target: 'api::bank.bank', label: 'Banks' },
  ],
};

const PAGE_SIZE = 30;

function SelectedRelationRow({
  candidate,
  index,
  count,
  reorderable,
  removeDisabled,
  onDrop,
  onMove,
  onRemove,
}: {
  candidate: Candidate;
  index: number;
  count: number;
  reorderable: boolean;
  removeDisabled: boolean;
  onDrop: (draggedDocumentId: string, targetDocumentId: string) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (candidate: Candidate) => void;
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
    <div
      ref={rowRef}
      style={{
        opacity: isDragging ? 0.55 : 1,
      }}
    >
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

function useDeferredMount(): boolean {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const w = window as any;
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 1000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(() => setReady(true), 400);
    return () => clearTimeout(id);
  }, []);
  return ready;
}

function RelationSection({
  config,
  deferred,
  model,
  documentId,
}: {
  config: RelationConfig;
  deferred: boolean;
  model: string;
  documentId?: string;
}) {
  const { get } = useFetchClient();

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
  }, [debouncedSearch, config.target, config.scopeRelationField, documentId]);

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
    const exists = selectedList.some((s) => s.documentId === c.documentId);
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
                      disabled={!selectedRelationsReady}
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
                      !selectedDocIds.has(c.documentId) && atSelectionLimit
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

function PanelBody({
  model,
  documentId,
}: {
  model: string;
  documentId?: string;
}) {
  const deferred = useDeferredMount();
  return (
    <Box width="100%">
      {RELATION_CONFIG[model].map((cfg, idx) => (
        <React.Fragment key={cfg.field}>
          {idx > 0 ? <Divider /> : null}
          <RelationSection
            config={cfg}
            deferred={deferred}
            model={model}
            documentId={documentId}
          />
        </React.Fragment>
      ))}
    </Box>
  );
}

const RelationMultiSelectPanel: PanelComponent = ({ model, documentId }) => {
  if (!RELATION_CONFIG[model]) return null;

  return {
    title: 'Taxonomies',
    content: <PanelBody model={model} documentId={documentId} />,
  };
};

/**
 * Top Picks and Ordered Coupons were two separate sidebar panels. They are now
 * one full-width dialog (features/coupon-layout): the two selections interact —
 * a Coupon may not appear in both, and the server rejects the ENTIRE save if it
 * does — so editing them apart is what made the conflict easy to create.
 */
const EntityCouponLayoutPanel: PanelComponent = ({ model, documentId }) =>
  couponLayoutPanel(model, documentId);

// Bulk code import. The server-side importer already existed and was fully
// implemented — this panel is the only thing that was missing, so editors had
// no way to load a pool without hitting the API by hand.
const UNIQUE_CODE_IMPORT_UID = 'api::unique-coupon-pool.unique-coupon-pool';

// Registered by the plugin server (src/plugins/unique-coupon/server/src/
// index.ts) and enforced on its upload/stats routes; granted per role under
// Settings > Roles > Plugins. Module-level so useRBAC sees a stable reference.
const UNIQUE_CODE_IMPORT_PERMISSIONS = [
  { action: 'plugin::unique-coupon.codes.import' },
];

const UniqueCodeImportPanel: PanelComponent = ({ model, documentId }) => {
  // Called before the model early-return so the hook order never changes.
  const { isLoading, allowedActions } = useRBAC(UNIQUE_CODE_IMPORT_PERMISSIONS);

  if (model !== UNIQUE_CODE_IMPORT_UID) return null;

  // While permissions load, show nothing rather than flashing a panel that may
  // disappear; the server enforces the same action, this only hides the UI.
  if (isLoading || !allowedActions.canImport) return null;

  return {
    title: 'Import codes',
    content: <UniqueCodeImport documentId={documentId} />,
  };
};

// ---------------------------------------------------------------------------
// Validation-problems panel (homepage and Deal of the Day). Client-side checks
// and the server-side image validator put their errors into the same nested
// form-errors state ({ section: { items: [{ field: 'msg' }] } }); this panel
// flattens that into a human list with the numbered section names, so editors
// see exactly WHERE the save failed instead of hunting through every section.
// ---------------------------------------------------------------------------
const SECTION_LABEL_BY_MODEL: Record<string, Record<string, string>> = {
  [HOMEPAGE_UID]: Object.fromEntries(
    HOMEPAGE_SECTION_LABELS.map(({ attr, label }) => [attr, label])
  ),
  [DOTD_UID]: Object.fromEntries(
    DOTD_SECTION_LABELS.map(({ attr, label }) => [attr, label])
  ),
};

// Client-side (pre-save) errors are stored as react-intl message descriptors
// ({ id, defaultMessage, values? }), server-side ones as plain strings — the
// flattener must treat descriptors as leaves, not nested error objects.
type MessageDescriptorLike = {
  id: string;
  defaultMessage?: string;
  values?: Record<string, unknown>;
};

const isMessageDescriptor = (node: unknown): node is MessageDescriptorLike =>
  typeof node === 'object' &&
  node !== null &&
  !Array.isArray(node) &&
  typeof (node as MessageDescriptorLike).id === 'string' &&
  typeof (node as MessageDescriptorLike).defaultMessage === 'string';

type FlatError = {
  path: Array<string | number>;
  message: string | MessageDescriptorLike;
};

const flattenFormErrors = (
  node: unknown,
  path: Array<string | number> = []
): FlatError[] => {
  if (node == null) return [];
  if (typeof node === 'string' || isMessageDescriptor(node)) {
    return path.length ? [{ path, message: node }] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child, index) =>
      child == null ? [] : flattenFormErrors(child, [...path, index])
    );
  }
  if (typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) =>
      flattenFormErrors(value, [...path, key])
    );
  }
  return [];
};

// 'cardImage' -> 'card image'
const humanizeFieldName = (segment: string): string =>
  segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

// ['newlyAdded','items',1,'cardImage'] -> "7 · Fresh Drops … › items #2 › card image"
const describeErrorLocation = (
  path: Array<string | number>,
  model: string
): string => {
  const parts: string[] = [];
  path.forEach((segment, index) => {
    if (typeof segment === 'number') {
      parts[parts.length - 1] = `${parts[parts.length - 1] ?? ''} #${segment + 1}`;
      return;
    }
    parts.push(
      index === 0
        ? SECTION_LABEL_BY_MODEL[model]?.[segment] ?? humanizeFieldName(segment)
        : humanizeFieldName(segment)
    );
  });
  return parts.join(' › ');
};

// "newlyAdded.items[].cardImage" rule paths, keyed without indices so an error
// path like newlyAdded.items.1.cardImage can look up its size requirement.
const IMAGE_RULE_BY_PATH = new Map(
  HOMEPAGE_IMAGE_RULES.map((rule) => [rule.path.replace('[]', ''), rule])
);

const imageHintFor = (path: Array<string | number>): string | null => {
  const key = path.filter((segment) => typeof segment === 'string').join('.');
  const rule = IMAGE_RULE_BY_PATH.get(key);
  return rule ? `Upload the ${rule.label} — exactly ${rule.width}×${rule.height} px.` : null;
};

function ValidationProblemsList({
  problems,
  model,
  intro,
}: {
  problems: FlatError[];
  model: string;
  /** Overrides the default copy, which assumes the fields are marked in red. */
  intro?: string;
}) {
  const { formatMessage } = useIntl();

  const messageText = (message: FlatError['message']): string =>
    typeof message === 'string'
      ? message
      : formatMessage(
          { id: message.id, defaultMessage: message.defaultMessage },
          message.values as any
        );

  return (
    <Flex direction="column" alignItems="stretch" gap={3} width="100%">
      <Typography variant="pi" textColor="neutral600">
        {intro ??
          'Fix these to save. Each problem field is also marked in red in the ' +
            'form, and any repeatable rows with problems open automatically.'}
      </Typography>
      {problems.map((problem) => {
        // Server messages are already specific ("got 800×400 …") — only swap
        // in the size hint for the generic client-side "This value is required."
        const isGenericClientMessage = typeof problem.message !== 'string';
        const hint = isGenericClientMessage ? imageHintFor(problem.path) : null;
        return (
          <Box key={problem.path.join('.')}>
            <Typography variant="pi" fontWeight="bold" textColor="danger600" tag="p">
              {describeErrorLocation(problem.path, model)}
            </Typography>
            <Typography variant="pi" textColor="danger600" tag="p">
              {hint ?? messageText(problem.message)}
            </Typography>
          </Box>
        );
      })}
    </Flex>
  );
}

// The homepage-style "Validation problems" side panel, on EVERY content type.
// Any create/update validation failure — client-side required-field checks or a
// server ValidationError whose details.errors[].path map onto form fields (e.g.
// the coupon/deal offer-text word caps) — is listed here with the offending
// field highlighted inline.
//
// This used to be gated on a hardcoded eight-UID allowlist, which meant the same
// save failure read completely differently depending on the screen: redirects,
// jobs, job applications, unique coupon pools and every single type got a bare
// multi-line toast and no panel — exactly the screens where a toast is hardest
// to act on. Nothing in the panel needs per-model knowledge to work:
// flattenFormErrors walks arbitrary nested error state, and
// pendingRequiredFields reads the content-manager's own schema attributes. The
// two model-keyed lookups it does consult (SECTION_LABEL_BY_MODEL,
// IMAGE_RULE_BY_PATH) already fall through to humanizeFieldName, so an unlisted
// model gets sensible generic labels rather than nothing.
const ValidationProblemsPanel: PanelComponent = ({ model }) => {
  const formErrors = useForm('ValidationProblemsPanel', (state) => state.errors);
  const formValues = useForm('ValidationProblemsPanel', (state) => state.values);
  const { contentType, components, isCreatingEntry } =
    unstable_useContentManagerContext();

  const submitProblems = flattenFormErrors(formErrors);

  if (submitProblems.length > 0) {
    return {
      title: `Validation problems (${submitProblems.length})`,
      content: <ValidationProblemsList problems={submitProblems} model={model} />,
    };
  }

  // Nothing has been submitted yet. Many rows here predate newer required-field
  // rules (205 entities are missing alt text), so list what is already missing
  // the moment the record opens — otherwise the editor only finds out when
  // their save bounces. Skipped while CREATING: an
  // empty new form would open with every required field listed as a problem,
  // which reads as broken rather than helpful.
  if (isCreatingEntry) return null;

  const pending = pendingRequiredFields(
    contentType as any,
    components as any,
    formValues as Record<string, unknown>,
  );
  if (pending.length === 0) return null;

  return {
    title: `Needs attention (${pending.length})`,
    content: <PendingRequiredList pending={pending} />,
  };
};

function PendingRequiredList({ pending }: { pending: PendingField[] }) {
  return (
    <Flex direction="column" alignItems="stretch" gap={3} width="100%">
      <Typography variant="pi" textColor="neutral600">
        This entry is missing {pending.length === 1 ? 'a field' : 'fields'} that
        are now required. The save will be rejected until{' '}
        {pending.length === 1 ? 'it is' : 'they are'} filled in.
      </Typography>
      {pending.map((field) => (
        <Box key={field.path.join('.')}>
          <Typography variant="pi" fontWeight="bold" textColor="warning600" tag="p">
            {field.label}
          </Typography>
        </Box>
      ))}
    </Flex>
  );
}

/**
 * Content-manager list rows are `<tr>`s with a JS click handler, so middle-click,
 * Cmd-click and right-click → "Open in New Tab" all do nothing and editors can't
 * fan a review queue out into tabs. Strapi CE exposes no cell override; the only
 * supported seam is this waterfall, whose `cellFormatter` fully owns a cell's
 * rendering — so re-render the lead column as a real `<a href>` to the edit view.
 *
 * Scoped to the FIRST column (the one editors aim at) and to plain-text
 * attributes on purpose: taking over a relation/media/component cell would mean
 * reimplementing its popovers and thumbnails, and a broken list view blocks all
 * content editing. i18n appends its "Available in" column to the END of this
 * same list, so the first entry is always a real content column.
 */
const INJECT_COLUMN_IN_TABLE = 'Admin/CM/pages/ListView/inject-column-in-table';

type ListViewHeaders = { displayedHeaders: any[]; layout: unknown };

const linkifyFirstColumnHook = ({ displayedHeaders, layout }: ListViewHeaders) => {
  const [first, ...rest] = displayedHeaders ?? [];

  // Leave the table untouched unless the lead column is plain text and no other
  // plugin has already claimed its rendering.
  if (!first || first.cellFormatter || !isLinkableCellType(first.attribute?.type)) {
    return { displayedHeaders, layout };
  }

  return {
    layout,
    displayedHeaders: [
      {
        ...first,
        // Returning an element (not calling hooks here) matters: cellFormatter is
        // invoked inline in the row loop, so useHref must live one component down.
        cellFormatter: (row: any, header: any, meta: any) => (
          <EntryLinkCell
            collectionType={meta?.collectionType}
            model={meta?.model}
            documentId={row?.documentId}
            // Same lookup Strapi's own CellContent does: the header name is
            // suffixed with `.mainField` before it reaches us.
            content={row?.[String(header?.name ?? '').split('.')[0]]}
            withTooltip={header?.attribute?.type === 'string'}
          />
        ),
      },
      ...rest,
    ],
  };
};

export default {
  register(app: StrapiApp) {
    // Strapi registers plugin fields before the application's register hook.
    // Keep the stock media input for every field except Product Deal.dealImage,
    // whose dedicated uploader guarantees transparent-only AWS persistence.
    const standardMediaInput = (app as any).library?.fields?.media;
    if (standardMediaInput) {
      app.addFields({
        type: 'media',
        Component: createDealAwareMediaInput(standardMediaInput),
      } as any);
    }
    // Replace the built-in markdown editor for ALL `richtext` fields with the
    // TipTap WYSIWYG (the fields store HTML, rendered raw on the site). NOTE:
    // in Strapi 5 the registry key must be the raw attribute type 'richtext'
    // — the v4 'wysiwyg' key silently does nothing.
    app.addFields({ type: 'richtext', Component: RichTextEditor } as any);
    // Same picker as Strapi's built-in datetime input, but with 5-minute time
    // steps (QC: coupon schedule needs finer granularity than 15 min).
    app.addFields({ type: 'datetime', Component: DateTimeInput } as any);
    // Confirmation dialog before any boolean toggle flips (QC: avoid accidental
    // ON/OFF from a stray click).
    app.addFields({ type: 'boolean', Component: BooleanConfirmInput } as any);
    // Slug fields are plain `string` attributes (schema-regex-validated, typed
    // by hand) — the former uid SlugInput and its Regenerate button are gone.

    // Generated Product Deal pages (/<slugified-entity-name>-deals/) have no content
    // type of their own — they are derived from the four entity collections —
    // so there is nothing for the Content Manager to list. This screen is the
    // only surface for them. `permissions: []` gates nothing on its own: the
    // endpoints behind it are Super-Admin-only server-side, and the page
    // renders the resulting 403 as an explanation rather than an empty table.
    app.addMenuLink({
      to: '/entity-deal-pages',
      icon: Earth,
      permissions: [],
      intlLabel: {
        id: 'entity-deal-pages.menu.label',
        defaultMessage: 'Deal page SEO',
      },
      Component: async () => {
        const page = await import(
          './features/entity-deal-page-seo/components/entity-deal-page-seo-page'
        );
        return { default: page.default };
      },
    });
  },

  config: {
    auth: { // Replace the Strapi logo in auth (login) views
      logo: Logo,
    },
    menu: { // Replace the Strapi logo in the main navigation
      logo: Logo,
    },
    locales: ['en'],
    translations: {
      en: {
        'Auth.form.welcome.title': 'Welcome to CouponzGuru',
        'Auth.form.welcome.subtitle': 'Log in to your account',
        // The media-library selection dialog uses this global action label.
        'global.finish': 'Confirm',
        // Shown when the pre-save (client-side) check finds empty required
        // fields — the request never reaches the server in that case, so the
        // detailed server toast can't appear. Point editors at the panel.
        'content-manager.validation.error':
          'Some required fields are empty or invalid. See the "Validation problems" panel on the right — problem fields are marked in red and their rows open automatically.',
      },
    }
  },
  bootstrap(app: StrapiApp) {
    installRecordLockLeaseInterceptor();
    const contentManager = app.getPlugin('content-manager') as any;
    const apis = contentManager.apis;
    apis.addDocumentAction([PublicOfferLinkAction, BumpToTopAction]);

    // Published / Scheduled / Expired shortcuts in the Coupon and Product Deal
    // list toolbars. `listView.actions` is the only list-view injection zone
    // Strapi 5 exposes — see the component for why that shapes the UI.
    contentManager.injectComponent('listView', 'actions', {
      name: 'offer-status-tabs',
      Component: OfferStatusTabs,
    });
    // Panel order = the order editors read them. Strapi's own "Entry" panel
    // (Save, Publish) is always first; Publishing sits directly under it
    // because scheduling is what an editor checks right before saving.
    apis.addEditViewSidePanel([
      // First so the "someone else is editing" warning is the first thing an
      // editor sees; it also owns the heartbeat that holds the edit lock.
      RecordLockPanel,
      PublishingPanel,
      OfferBenefitsPanel,
      RelationMultiSelectPanel,
      EntityCouponLayoutPanel,
      UniqueCodeImportPanel,
      ValidationProblemsPanel,
    ]);

    // Registered after every plugin's bootstrap, so this sees (and preserves)
    // any column i18n or review-workflows already injected.
    app.registerHook(INJECT_COLUMN_IN_TABLE, linkifyFirstColumnHook);

    if (typeof document !== 'undefined') {
      const rewrite = () => {
        if (document.title.includes('Strapi')) {
          document.title = document.title.replace(/Strapi/g, 'CouponzGuru');
        }
      };
      rewrite();
      const titleEl = document.querySelector('title');
      if (titleEl) {
        new MutationObserver(rewrite).observe(titleEl, { childList: true });
      }

      // QC bug: pressing Enter while typing a store/brand name submitted the
      // edit form and created the entry. Swallow Enter on single-line text
      // inputs inside the content-manager edit view so it never auto-submits.
      // Textareas, the rich-text editor (contenteditable), and comboboxes
      // (which use Enter to pick an option) are left untouched.
      document.addEventListener(
        'keydown',
        (e: KeyboardEvent) => {
          if (e.key !== 'Enter') return;
          if (!window.location.pathname.includes('/content-manager/')) return;
          const el = e.target as HTMLElement | null;
          if (!el || el.tagName !== 'INPUT') return;
          const input = el as HTMLInputElement;
          if (input.getAttribute('role') === 'combobox') return;
          if (input.getAttribute('aria-autocomplete')) return;
          // The list-view search bar (and the relation-picker search) submit on
          // Enter to apply the query — they live inside <form role="search">.
          // Swallowing Enter there silently breaks search on EVERY content type
          // (Strapi's SearchInput has no submit button; Enter is the only trigger).
          if (input.closest('form[role="search"]')) return;
          const type = (input.type || 'text').toLowerCase();
          if (['text', 'search', 'url', 'email', 'tel', 'number', 'password'].includes(type)) {
            e.preventDefault();
          }
        },
        true
      );
    }
  },
};
