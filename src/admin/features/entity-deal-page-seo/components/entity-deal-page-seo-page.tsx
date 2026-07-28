import * as React from 'react';
import {
  Button,
  Flex,
  IconButton,
  SingleSelect,
  SingleSelectOption,
  Status,
  Tooltip,
  Typography,
  type StatusVariant,
} from '@strapi/design-system';
import { Duplicate, Pencil } from '@strapi/icons';
import {
  Layouts,
  Page,
  Pagination,
  SearchInput,
  Table,
  useFetchClient,
  useNotification,
  useQueryParams,
} from '@strapi/strapi/admin';

import type { IdentityKind } from '../../../../utils/route-normalization';
import {
  DEFAULT_SORT_PARAM,
  listQueryString,
  parseSearch,
  parseSort,
  toSeoPatch,
  unwrapList,
  updatePath,
  type SeoFormState,
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

const DEFAULT_PAGE_SIZE = 25;
// 25 must appear here or the page-size select would render a value it has no
// option for. The rest mirror Strapi's own defaults.
const PAGE_SIZE_OPTIONS = ['10', '25', '50', '100'];

const STATUS_VARIANT: Record<IndexState, StatusVariant> = {
  enabled: 'success',
  // "Off" is a deliberate editorial choice, "Blocked" means the editor asked
  // for indexing and something is preventing it — only the latter is a problem.
  disabled: 'secondary',
  blocked: 'danger',
};

/**
 * Column definitions. `name` doubles as the sort key sent to the server, so the
 * sortable entries must match SORT_FIELDS in `../api` (and SETTINGS_SORT_FIELDS
 * in the entity-deal-page service).
 */
const HEADERS: { name: string; label: string; sortable: boolean }[] = [
  { name: 'name', label: 'Entity', sortable: true },
  { name: 'permalink', label: 'Permalink', sortable: false },
  { name: 'liveDealCount', label: 'Live Deals', sortable: true },
  { name: 'indexState', label: 'Index state', sortable: false },
  { name: 'updatedAt', label: 'Updated', sortable: true },
  { name: 'actions', label: 'Actions', sortable: false },
];

type ListQueryParams = {
  page?: string;
  pageSize?: string;
  sort?: string;
  kind?: string;
  indexState?: string;
  _q?: string;
};

/**
 * `Table.Root` requires an `id` on every row, but the entity's own numeric `id`
 * is only unique within one content type and this list mixes all four. Carry a
 * composite key beside the row rather than overwriting it.
 */
type TableRow = { id: string; row: EntityDealPageRow };

function formatUpdatedAt(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

export default function EntityDealPageSeoPage() {
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();

  // All list state lives in the URL: a filtered view is shareable, survives a
  // refresh, and the browser Back button undoes a filter the way it does on
  // every other Strapi list screen.
  const [{ query }, setQuery] = useQueryParams<ListQueryParams>({
    page: '1',
    pageSize: String(DEFAULT_PAGE_SIZE),
    sort: DEFAULT_SORT_PARAM,
  });

  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || DEFAULT_PAGE_SIZE;
  const sort = parseSort(query.sort);
  const search = parseSearch(query._q);
  const kind = (query.kind ?? '') as IdentityKind | '';
  const indexState = (query.indexState ?? '') as IndexState | '';

  const [rows, setRows] = React.useState<EntityDealPageRow[]>([]);
  const [pageCount, setPageCount] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [forbidden, setForbidden] = React.useState(false);

  const [editing, setEditing] = React.useState<EntityDealPageRow | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  // Any filter change invalidates the current page number: page 3 of an A-Z
  // list has nothing to do with page 3 of a most-Deals-first list.
  const setFilter = (next: Partial<ListQueryParams>) =>
    setQuery({ ...next, page: '1' });

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      setForbidden(false);
      try {
        const response = await get(
          listQueryString({ page, pageSize, kind, indexState, search, sort }),
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
        if (status === 403 || status === 401) {
          setForbidden(true);
        } else {
          setError(err?.message ?? 'Failed to load Deal page settings.');
        }
        setRows([]);
        setTotal(0);
        setPageCount(1);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
    // `sort` and the primitives it is derived from change together; depending on
    // the parsed object would re-fetch on every render.
  }, [
    get,
    page,
    pageSize,
    kind,
    indexState,
    search,
    query.sort,
    reloadToken,
  ]);

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

  if (forbidden) {
    return (
      <Page.Main>
        <Page.Title>Deal page SEO</Page.Title>
        <Page.NoPermissions />
      </Page.Main>
    );
  }

  if (error) {
    return (
      <Page.Main>
        <Page.Title>Deal page SEO</Page.Title>
        <Page.Error content={error} />
      </Page.Main>
    );
  }

  const tableRows: TableRow[] = rows.map((row) => ({
    id: `${row.entityType}:${row.documentId}`,
    row,
  }));

  const hasFilters = Boolean(search || kind || indexState);

  return (
    <Page.Main>
      <Page.Title>Deal page SEO</Page.Title>
      <Layouts.Root>
        <Layouts.Header
          title="Deal page SEO"
          subtitle={`Generated Product Deal pages for stores, brands, categories and banks — ${total} total`}
        />

        <Layouts.Action
          startActions={
            <>
              <SearchInput
                label="Search Deal pages"
                placeholder="Search name, slug or permalink"
              />
              <SingleSelect
                aria-label="Entity type"
                placeholder="All types"
                value={kind}
                onClear={() => setFilter({ kind: '' })}
                onChange={(value: string | number) =>
                  setFilter({ kind: String(value) })
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
                onClear={() => setFilter({ indexState: '' })}
                onChange={(value: string | number) =>
                  setFilter({ indexState: String(value) })
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
          <Table.Root rows={tableRows} headers={HEADERS} isLoading={loading}>
            <Table.Content>
              <Table.Head>
                {HEADERS.map((header) => (
                  <Table.HeaderCell key={header.name} {...header} />
                ))}
              </Table.Head>
              <Table.Loading>Loading Deal pages…</Table.Loading>
              <Table.Empty
                content={
                  hasFilters
                    ? 'No Deal pages match these filters.'
                    : 'No Deal pages yet.'
                }
                action={
                  hasFilters ? (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setQuery(
                          { kind: '', indexState: '', _q: '', page: '1' },
                          'remove',
                        )
                      }
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
              <Table.Body>
                {tableRows.map(({ id, row }) => (
                  <Table.Row key={id}>
                    <Table.Cell>
                      <Flex direction="column" alignItems="start">
                        <Typography fontWeight="semiBold">{row.name}</Typography>
                        <Typography variant="pi" textColor="neutral600">
                          {row.entityType}
                        </Typography>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
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
                    </Table.Cell>
                    <Table.Cell>
                      <Typography
                        textColor={row.liveDealCount > 0 ? 'neutral800' : 'danger600'}
                      >
                        {row.liveDealCount}
                      </Typography>
                    </Table.Cell>
                    <Table.Cell>
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
                    </Table.Cell>
                    <Table.Cell>
                      <Typography variant="pi" textColor="neutral600">
                        {formatUpdatedAt(row.updatedAt)}
                      </Typography>
                    </Table.Cell>
                    <Table.Cell>
                      <Button
                        variant="tertiary"
                        size="S"
                        startIcon={<Pencil />}
                        onClick={() => setEditing(row)}
                      >
                        Edit SEO
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.Root>

          <Pagination.Root
            pageCount={pageCount}
            total={total}
            defaultPageSize={DEFAULT_PAGE_SIZE}
          >
            <Pagination.PageSize options={PAGE_SIZE_OPTIONS} />
            <Pagination.Links />
          </Pagination.Root>
        </Layouts.Content>
      </Layouts.Root>

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
