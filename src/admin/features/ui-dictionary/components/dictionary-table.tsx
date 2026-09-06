// The rows: Key · English · Translation · Status · Updated · actions.
// Presentational — filtering lives in ../filter-entries, mutations in
// ../use-ui-dictionary-actions.
import * as React from 'react';
import { Badge, Button, Flex, Status, Typography, type StatusVariant } from '@strapi/design-system';
import { ArrowClockwise, Cross, Pencil } from '@strapi/icons';
import { Table } from '@strapi/strapi/admin';

import { ENGLISH_CODE, type EntryStatus, type UiDictionaryEntry, type UiLanguage } from '../types';

const STATUS_LABEL: Record<EntryStatus, string> = {
  missing: 'Missing',
  stale: 'Out of date',
  ai: 'AI',
  manual: 'Manual',
  source: 'Catalogue',
  override: 'Override',
};

const STATUS_VARIANT: Record<EntryStatus, StatusVariant> = {
  missing: 'danger',
  stale: 'warning',
  ai: 'secondary',
  manual: 'success',
  source: 'neutral',
  override: 'primary',
};

type Header = { name: string; label: string; sortable: boolean };

function headersFor(isEnglish: boolean): Header[] {
  return [
    { name: 'key', label: 'Key', sortable: false },
    { name: 'english', label: 'English', sortable: false },
    ...(isEnglish ? [] : [{ name: 'translation', label: 'Translation', sortable: false }]),
    { name: 'status', label: 'Status', sortable: false },
    { name: 'updatedAt', label: 'Updated', sortable: false },
    { name: 'actions', label: 'Actions', sortable: false },
  ];
}

/** The row's own last write: the translation's, or on the English tab the override's. */
export function formatUpdated(entry: UiDictionaryEntry): string {
  const value = entry.translation?.updatedAt ?? entry.source.overrideUpdatedAt;
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

type Row = { id: string; entry: UiDictionaryEntry };

export function DictionaryTable({
  language,
  entries,
  loading,
  hasFilters,
  translationActive,
  busy,
  onClearFilters,
  onEdit,
  onReset,
}: {
  language: UiLanguage;
  entries: UiDictionaryEntry[];
  loading: boolean;
  hasFilters: boolean;
  translationActive: boolean;
  busy: boolean;
  onClearFilters: () => void;
  onEdit: (entry: UiDictionaryEntry) => void;
  onReset: (entry: UiDictionaryEntry) => void;
}) {
  const isEnglish = language.code === ENGLISH_CODE;
  const headers = headersFor(isEnglish);
  const rows: Row[] = entries.map((entry) => ({ id: entry.key, entry }));

  return (
    <Table.Root rows={rows} headers={headers} isLoading={loading}>
      <Table.Content>
        <Table.Head>
          {headers.map((header) => (
            <Table.HeaderCell key={header.name} {...header} />
          ))}
        </Table.Head>
        <Table.Loading>Loading UI text…</Table.Loading>
        <Table.Empty
          content={hasFilters ? 'No keys match these filters.' : 'No keys in the catalogue yet.'}
          action={
            hasFilters ? (
              <Button variant="secondary" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
        <Table.Body>
          {rows.map(({ id, entry }) => (
            <Table.Row key={id}>
              <Table.Cell>
                <Flex direction="column" alignItems="start" gap={1}>
                  <Typography fontWeight="semiBold" style={{ wordBreak: 'break-all' }}>
                    {entry.key}
                  </Typography>
                  <Flex gap={1}>
                    {entry.source.removedAt ? <Badge variant="danger" size="S">removed</Badge> : null}
                    {entry.source.pluralCategory ? (
                      <Badge size="S">{`plural · ${entry.source.pluralCategory}`}</Badge>
                    ) : null}
                    {entry.source.maxLength ? <Badge size="S">{`≤ ${entry.source.maxLength}`}</Badge> : null}
                  </Flex>
                </Flex>
              </Table.Cell>
              <Table.Cell>
                <Flex gap={2} alignItems="center" wrap="wrap">
                  <Typography style={entry.source.overrideText !== null ? { fontStyle: 'italic' } : undefined}>
                    {entry.source.effectiveText}
                  </Typography>
                  {entry.source.overrideText !== null ? <Badge active size="S">override</Badge> : null}
                </Flex>
              </Table.Cell>
              {isEnglish ? null : (
                <Table.Cell>
                  <Typography dir={language.dir} textColor={entry.translation ? 'neutral800' : 'neutral500'}>
                    {entry.translation?.text ?? '—'}
                  </Typography>
                </Table.Cell>
              )}
              <Table.Cell>
                <Status variant={STATUS_VARIANT[entry.status]} size="S">
                  <Typography variant="pi" fontWeight="bold">
                    {STATUS_LABEL[entry.status]}
                  </Typography>
                </Status>
              </Table.Cell>
              <Table.Cell>
                <Typography variant="pi" textColor="neutral600">
                  {formatUpdated(entry)}
                </Typography>
              </Table.Cell>
              <Table.Cell>
                <Flex gap={2}>
                  <Button
                    variant="tertiary"
                    size="S"
                    startIcon={<Pencil />}
                    disabled={busy || Boolean(entry.source.removedAt)}
                    onClick={() => onEdit(entry)}
                  >
                    Edit
                  </Button>
                  {isEnglish && entry.source.overrideText !== null ? (
                    <Button variant="danger-light" size="S" startIcon={<Cross />} disabled={busy} onClick={() => onReset(entry)}>
                      Clear override
                    </Button>
                  ) : null}
                  {!isEnglish && entry.translation && translationActive ? (
                    <Button variant="danger-light" size="S" startIcon={<ArrowClockwise />} disabled={busy} onClick={() => onReset(entry)}>
                      Reset to AI
                    </Button>
                  ) : null}
                </Flex>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Content>
    </Table.Root>
  );
}
