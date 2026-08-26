// The Deal-page SEO results table: rows, status tooltips, copy-permalink
// and per-row edit actions. Purely presentational — state lives in
// ../use-seo-list.
import * as React from 'react';
import {
  Button,
  Flex,
  IconButton,
  Status,
  Tooltip,
  Typography,
} from '@strapi/design-system';
import { Duplicate, Pencil } from '@strapi/icons';
import { Table } from '@strapi/strapi/admin';

import { BLOCKER_LABELS, INDEX_STATE_LABELS, type EntityDealPageRow } from '../types';
import {
  HEADERS,
  STATUS_VARIANT,
  formatUpdatedAt,
  type TableRow,
} from '../seo-list-config';

export function SeoListTable({
  tableRows,
  loading,
  hasFilters,
  onClearFilters,
  onCopyPermalink,
  onEdit,
}: {
  tableRows: TableRow[];
  loading: boolean;
  hasFilters: boolean;
  onClearFilters: () => void;
  onCopyPermalink: (row: EntityDealPageRow) => void;
  onEdit: (row: EntityDealPageRow) => void;
}) {
  return (
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
                    <Button variant="secondary" onClick={onClearFilters}>
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
                          onClick={() => onCopyPermalink(row)}
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
                        onClick={() => onEdit(row)}
                      >
                        Edit SEO
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.Root>
  );
}
