// Composition for the Deal-page SEO screen: query state from
// ../use-seo-list, filter row and table from ./seo-list-filters and
// ./seo-list-table, save/copy actions and the edit dialog here.
import * as React from 'react';
import { Button } from '@strapi/design-system';
import {
  Layouts,
  Page,
  Pagination,
  useFetchClient,
  useNotification,
} from '@strapi/strapi/admin';

import { toSeoPatch, updatePath, type SeoFormState } from '../api';
import { type EntityDealPageRow } from '../types';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  type TableRow,
} from '../seo-list-config';
import { useSeoList } from '../use-seo-list';
import SeoEditDialog from './seo-edit-dialog';
import { SeoListFilters } from './seo-list-filters';
import { SeoListTable } from './seo-list-table';

export default function EntityDealPageSeoPage() {
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const {
    setQuery,
    setFilter,
    search,
    kind,
    indexState,
    rows,
    pageCount,
    total,
    loading,
    error,
    forbidden,
    reload,
  } = useSeoList(get);

  const [editing, setEditing] = React.useState<EntityDealPageRow | null>(null);
  const [saving, setSaving] = React.useState(false);

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
      reload();
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
            <SeoListFilters
              kind={kind}
              indexState={indexState}
              setFilter={setFilter}
            />
          }
        />

        <Layouts.Content>
          <SeoListTable
            tableRows={tableRows}
            loading={loading}
            hasFilters={hasFilters}
            onClearFilters={() =>
              setQuery({ kind: '', indexState: '', _q: '', page: '1' }, 'remove')
            }
            onCopyPermalink={copyPermalink}
            onEdit={setEditing}
          />

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
