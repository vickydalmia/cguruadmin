import * as React from 'react';
import {
  Box,
  Button,
  Flex,
  IconButton,
  Loader,
  Searchbar,
  SingleSelect,
  SingleSelectOption,
  Status,
  Table,
  Tbody,
  Td,
  TextButton,
  Th,
  Thead,
  Tooltip,
  Tr,
  Typography,
  type StatusVariant,
} from '@strapi/design-system';
import { CaretDown, CaretUp, Duplicate, Pencil } from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

import type { IdentityKind } from '../../../../utils/route-normalization';
import {
  DEFAULT_SORT,
  listQueryString,
  nextSort,
  toSeoPatch,
  unwrapList,
  updatePath,
  type SeoFormState,
  type Sort,
  type SortField,
} from '../api';
import {
  BLOCKER_LABELS,
  ENTITY_KINDS,
  INDEX_STATES,
  INDEX_STATE_LABELS,
  type EntityDealPageRow,
  type IndexState,
} from '../types';
import SeoEditDialog from './seo-edit-dialog';

const PAGE_SIZE = 25;

const STATUS_VARIANT: Record<IndexState, StatusVariant> = {
  enabled: 'success',
  // "Off" is a deliberate editorial choice, "Blocked" means the editor asked
  // for indexing and something is preventing it — only the latter is a problem.
  disabled: 'secondary',
  blocked: 'danger',
};

/**
 * A sortable column header.
 *
 * `aria-sort` on the cell is what tells a screen-reader user the table is
 * ordered and by which column — the arrow glyph alone conveys nothing.
 */
function SortableTh({
  field,
  label,
  sort,
  onSort,
}: {
  field: SortField;
  label: string;
  sort: Sort;
  onSort: (sort: Sort) => void;
}) {
  const active = sort.field === field;
  const ariaSort = active ? (sort.desc ? 'descending' : 'ascending') : 'none';

  return (
    <Th aria-sort={ariaSort}>
      <TextButton onClick={() => onSort(nextSort(sort, field))}>
        <Flex gap={1} alignItems="center">
          <Typography
            variant="sigma"
            textColor={active ? 'primary600' : undefined}
          >
            {label}
          </Typography>
          {active ? (
            sort.desc ? <CaretDown width="1rem" /> : <CaretUp width="1rem" />
          ) : null}
        </Flex>
      </TextButton>
    </Th>
  );
}

function formatUpdatedAt(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

export default function EntityDealPageSeoPage() {
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [rows, setRows] = React.useState<EntityDealPageRow[]>([]);
  const [pageCount, setPageCount] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [page, setPage] = React.useState(1);
  const [kind, setKind] = React.useState<IdentityKind | ''>('');
  const [indexState, setIndexState] = React.useState<IndexState | ''>('');
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [sort, setSort] = React.useState<Sort>(DEFAULT_SORT);

  const [editing, setEditing] = React.useState<EntityDealPageRow | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Any filter or sort change invalidates the current page number: page 3 of
  // an A-Z list has nothing to do with page 3 of a most-Deals-first list.
  React.useEffect(() => setPage(1), [debouncedSearch, kind, indexState, sort]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await get(
          listQueryString({
            page,
            pageSize: PAGE_SIZE,
            kind,
            indexState,
            search: debouncedSearch,
            sort,
          }),
        );
        if (cancelled) return;
        const list = unwrapList(response?.data);
        setRows(list.data);
        setPageCount(list.meta.pagination.pageCount);
        setTotal(list.meta.pagination.total);
      } catch (err: any) {
        if (cancelled) return;
        // 403 here means the account is not a Super Admin. Say that, rather
        // than showing an empty table that looks like "no entities exist".
        const status = err?.response?.status;
        setError(
          status === 403 || status === 401
            ? 'Only a Super Admin can view Deal page SEO settings.'
            : (err?.message ?? 'Failed to load Deal page settings.'),
        );
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [get, page, kind, indexState, debouncedSearch, sort, reloadToken]);

  const copyPermalink = async (row: EntityDealPageRow) => {
    try {
      await navigator.clipboard.writeText(row.permalink);
      toggleNotification({ type: 'success', message: 'Permalink copied.' });
    } catch {
      toggleNotification({ type: 'warning', message: 'Could not copy.' });
    }
  };

  const save = async (form: SeoFormState) => {
    if (!editing) return;
    setSaving(true);
    try {
      await put(updatePath(editing.entityType, editing.documentId), {
        data: { entityDealPageSeo: toSeoPatch(form) },
      });
      toggleNotification({ type: 'success', message: 'Deal page SEO saved.' });
      setEditing(null);
      // Re-read rather than patching state locally: resolvedSeo and the
      // blocker list are computed server-side, so the row on screen must come
      // back from the server or it will disagree with what is published.
      setReloadToken((token) => token + 1);
    } catch (err: any) {
      const details: string[] = err?.response?.data?.error?.details?.problems ?? [];
      toggleNotification({
        type: 'danger',
        message: details.length
          ? details.join(' ')
          : (err?.response?.data?.error?.message ?? 'Could not save.'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page.Main>
      <Page.Title>Deal page SEO</Page.Title>
      <Layouts.Header
        title="Deal page SEO"
        subtitle={`Generated Product Deal pages for stores, brands, categories and banks — ${total} total`}
      />

      <Layouts.Action
        startActions={
          <>
            <Searchbar
              name="search"
              value={search}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setSearch(event.target.value)
              }
              onClear={() => setSearch('')}
              clearLabel="Clear search"
              placeholder="Search name, slug or permalink"
            >
              Search Deal pages
            </Searchbar>
            <SingleSelect
              aria-label="Entity type"
              placeholder="All types"
              value={kind}
              onClear={() => setKind('')}
              onChange={(value: string | number) =>
                setKind(String(value) as IdentityKind)
              }
            >
              {ENTITY_KINDS.map((value) => (
                <SingleSelectOption key={value} value={value}>
                  {value}
                </SingleSelectOption>
              ))}
            </SingleSelect>
            <SingleSelect
              aria-label="Index state"
              placeholder="All states"
              value={indexState}
              onClear={() => setIndexState('')}
              onChange={(value: string | number) =>
                setIndexState(String(value) as IndexState)
              }
            >
              {INDEX_STATES.map((value) => (
                <SingleSelectOption key={value} value={value}>
                  {INDEX_STATE_LABELS[value]}
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </>
        }
      />

      <Layouts.Content>
        {error ? (
          <Box padding={8} background="neutral0" hasRadius>
            <Typography textColor="danger600">{error}</Typography>
          </Box>
        ) : loading ? (
          <Flex justifyContent="center" padding={8}>
            <Loader>Loading Deal pages…</Loader>
          </Flex>
        ) : rows.length === 0 ? (
          <Box padding={8} background="neutral0" hasRadius>
            <Typography textColor="neutral600">
              No Deal pages match these filters.
            </Typography>
          </Box>
        ) : (
          <Table colCount={6} rowCount={rows.length}>
            <Thead>
              <Tr>
                <SortableTh field="name" label="Entity" sort={sort} onSort={setSort} />
                <Th><Typography variant="sigma">Permalink</Typography></Th>
                <SortableTh
                  field="liveDealCount"
                  label="Live Deals"
                  sort={sort}
                  onSort={setSort}
                />
                <Th><Typography variant="sigma">Index state</Typography></Th>
                <SortableTh
                  field="updatedAt"
                  label="Updated"
                  sort={sort}
                  onSort={setSort}
                />
                <Th><Typography variant="sigma">Actions</Typography></Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((row) => (
                <Tr key={`${row.entityType}:${row.documentId}`}>
                  <Td>
                    <Flex direction="column" alignItems="start">
                      <Typography fontWeight="semiBold">{row.name}</Typography>
                      <Typography variant="pi" textColor="neutral600">
                        {row.entityType}
                      </Typography>
                    </Flex>
                  </Td>
                  <Td>
                    <Flex gap={2} alignItems="center">
                      <Typography variant="pi">{row.permalink}</Typography>
                      <IconButton
                        label="Copy permalink"
                        variant="ghost"
                        onClick={() => copyPermalink(row)}
                      >
                        <Duplicate />
                      </IconButton>
                    </Flex>
                  </Td>
                  <Td>
                    <Typography
                      textColor={row.liveDealCount > 0 ? 'neutral800' : 'danger600'}
                    >
                      {row.liveDealCount}
                    </Typography>
                  </Td>
                  <Td>
                    <Tooltip
                      label={
                        row.resolvedSeo.blockers.length
                          ? row.resolvedSeo.blockers
                              .map((blocker) => BLOCKER_LABELS[blocker])
                              .join('; ')
                          : 'No blockers — this page is indexable.'
                      }
                    >
                      <Status variant={STATUS_VARIANT[row.indexState]} size="S">
                        <Typography variant="pi" fontWeight="bold">
                          {INDEX_STATE_LABELS[row.indexState]}
                        </Typography>
                      </Status>
                    </Tooltip>
                  </Td>
                  <Td>
                    <Typography variant="pi" textColor="neutral600">
                      {formatUpdatedAt(row.updatedAt)}
                    </Typography>
                  </Td>
                  <Td>
                    <Button
                      variant="tertiary"
                      size="S"
                      startIcon={<Pencil />}
                      onClick={() => setEditing(row)}
                    >
                      Edit SEO
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}

        {pageCount > 1 ? (
          <Flex justifyContent="space-between" paddingTop={4} alignItems="center">
            <Button
              variant="tertiary"
              disabled={page <= 1 || loading}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Typography variant="pi" textColor="neutral600">
              {`Page ${page} of ${pageCount}`}
            </Typography>
            <Button
              variant="tertiary"
              disabled={page >= pageCount || loading}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            >
              Next
            </Button>
          </Flex>
        ) : null}
      </Layouts.Content>

      {editing ? (
        <SeoEditDialog
          row={editing}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </Page.Main>
  );
}
