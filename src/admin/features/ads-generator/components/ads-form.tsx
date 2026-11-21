import * as React from 'react';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { Duplicate, Plus, Trash } from '@strapi/icons';
import type { AdsGeneratorOptions } from '../../../../constants/ads-generator';
import { duplicateRow, newRow, type CampaignRow } from '../api';
import { AdsCampaignFields } from './ads-campaign-fields';

/** The campaign repeater: one open row at a time keeps a long batch readable. */
export function AdsForm({ options, rows, onChange, onSubmit, onNewBatch, busy, recovering }: {
  options: AdsGeneratorOptions;
  rows: CampaignRow[];
  onChange: (next: CampaignRow[]) => void;
  onSubmit: () => void;
  /** Clears every campaign and the output; asked to confirm first. */
  onNewBatch: () => void;
  busy: boolean;
  /** The last run is being recovered: edits would be overwritten. */
  recovering: boolean;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(rows[0]?.id ?? null);
  const max = options.limits.campaignsMax;
  const full = rows.length >= max;
  // A restored or removed row leaves a stale id: fall back to the first row.
  const activeId = openId !== null && !rows.some((row) => row.id === openId) ? rows[0]?.id : openId;
  const isOpen = (row: CampaignRow) => row.id === activeId;

  const add = (row: CampaignRow, at = rows.length) => {
    onChange([...rows.slice(0, at), row, ...rows.slice(at)]);
    setOpenId(row.id);
  };
  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id));
  const update = (id: string, value: CampaignRow['value']) => onChange(rows.map((row) => (row.id === id ? { ...row, value } : row)));

  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <Flex direction="column" alignItems="stretch" gap={4}>
        {rows.map((row, index) => (
          <Box key={row.id} borderColor="neutral200" hasRadius padding={4}>
            <Flex justifyContent="space-between" alignItems="center" gap={3} wrap="wrap">
              <Button type="button" variant="ghost" aria-expanded={isOpen(row)} onClick={() => setOpenId(isOpen(row) ? null : row.id)}>
                Campaign {index + 1}{row.value.campaignName.trim() ? `: ${row.value.campaignName.trim()}` : ''}
              </Button>
              <Flex gap={2}>
                <Button type="button" variant="tertiary" size="S" startIcon={<Duplicate />} disabled={busy || full} onClick={() => add(duplicateRow(row, rows), index + 1)}>
                  Duplicate
                </Button>
                <Button type="button" variant="danger-light" size="S" startIcon={<Trash />} disabled={busy || rows.length === 1} onClick={() => remove(row.id)}>
                  Remove
                </Button>
              </Flex>
            </Flex>
            {isOpen(row) && (
              <Box paddingTop={4}>
                <AdsCampaignFields options={options} value={row.value} disabled={recovering} onChange={(value) => update(row.id, value)} />
              </Box>
            )}
          </Box>
        ))}
        <Box>
          <Button type="button" variant="secondary" startIcon={<Plus />} disabled={busy || full} onClick={() => add(newRow())}>
            Add campaign ({rows.length} of {max})
          </Button>
        </Box>
        <Flex gap={3} alignItems="center" wrap="wrap">
          <Button type="submit" loading={busy} disabled={busy || !options.configured}>
            {rows.length > 1 ? `Generate ${rows.length} campaigns` : 'Generate ads'}
          </Button>
          {confirming ? (
            <Flex gap={2}>
              <Button type="button" variant="danger" onClick={() => { setConfirming(false); onNewBatch(); }}>Clear campaigns and results</Button>
              <Button type="button" variant="tertiary" onClick={() => setConfirming(false)}>Cancel</Button>
            </Flex>
          ) : (
            <Button type="button" variant="tertiary" disabled={busy} onClick={() => setConfirming(true)}>New batch</Button>
          )}
          <Typography variant="pi" textColor="neutral600">
            Creates one paused Search campaign CSV per campaign. Nothing is sent to Google Ads.
          </Typography>
        </Flex>
      </Flex>
    </form>
  );
}
