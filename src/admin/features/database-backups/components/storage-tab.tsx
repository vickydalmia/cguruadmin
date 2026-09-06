import * as React from 'react';
import { Badge, Box, Button, Flex, Grid, Typography } from '@strapi/design-system';
import { Check, Cross } from '@strapi/icons';

import { formatDateTime } from '../api';
import type { DatabaseBackupsState } from '../use-database-backups';

/**
 * Read-only view of the S3 target. Credentials come from the server
 * environment (BACKUP_S3_*), never from this page, so the only action here is
 * a permission-by-permission connection test.
 */

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Grid.Item col={6} s={12} xs={12}>
      <Flex direction="column" alignItems="start" gap={1}>
        <Typography variant="pi" textColor="neutral600">{label}</Typography>
        <Typography>{value ?? '—'}</Typography>
      </Flex>
    </Grid.Item>
  );
}

export function StorageTab({ state }: { state: DatabaseBackupsState }) {
  const { storage, runner } = state.overview!;
  const test = state.connectionTest;

  return (
    <Flex direction="column" alignItems="stretch" gap={6}>
      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
        <Flex justifyContent="space-between" alignItems="center" gap={4} wrap="wrap">
          <Flex direction="column" alignItems="start" gap={2}>
            <Typography variant="beta">Storage</Typography>
            <Badge variant={storage.configured ? 'success' : 'danger'}>
              {storage.configured ? 'Configured from the server environment' : 'Not configured'}
            </Badge>
          </Flex>
          <Button
            variant="secondary"
            disabled={!storage.configured || state.busy !== null}
            loading={state.busy === 'test-connection'}
            onClick={() => void state.testConnection()}
          >
            Test connection
          </Button>
        </Flex>
        <Box paddingTop={5}>
          <Grid.Root gap={5}>
            <Row label="Provider" value="Amazon S3" />
            <Row label="Bucket" value={storage.bucket} />
            <Row label="Region" value={storage.region ?? (storage.endpoint ? 'custom endpoint' : null)} />
            <Row label="Prefix" value={storage.prefix ? `${storage.prefix}/${storage.countryCode ?? '<country>'}/…` : null} />
            <Row
              label="Encryption at rest"
              value={storage.sse === 'aws:kms' ? `SSE-KMS (${storage.kmsKeyId ?? 'default key'})` : storage.sse === 'AES256' ? 'SSE-S3 (AES-256)' : storage.sse === 'none' ? 'None (custom endpoint)' : null}
            />
            <Row label="Access key" value={storage.accessKeyIdMasked} />
            {storage.endpoint ? <Row label="Endpoint" value={storage.endpoint} /> : null}
            <Row label="Country" value={storage.countryCode} />
          </Grid.Root>
        </Box>
        <Box paddingTop={4}>
          <Typography variant="pi" textColor="neutral600">
            Change these with the BACKUP_S3_* variables in the server environment and restart the
            containers. Secrets are never stored in the database.
          </Typography>
        </Box>
        {storage.problems.length > 0 ? (
          <Box paddingTop={4}>
            <Flex direction="column" alignItems="start" gap={1}>
              {storage.problems.map((problem) => (
                <Typography key={problem} variant="pi" textColor="danger600">{problem}</Typography>
              ))}
            </Flex>
          </Box>
        ) : null}
      </Box>

      {test ? (
        <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
          <Flex gap={3} alignItems="center">
            <Typography variant="beta">Connection test</Typography>
            <Badge variant={test.ok ? 'success' : 'danger'}>{test.ok ? 'All checks passed' : 'Failed'}</Badge>
            <Typography variant="pi" textColor="neutral600">{`${test.latencyMs} ms`}</Typography>
          </Flex>
          <Flex direction="column" alignItems="stretch" gap={2} paddingTop={4}>
            {test.checks.map((check) => (
              <Flex key={check.name} gap={2} alignItems="center">
                {check.ok ? <Check fill="success600" /> : <Cross fill="danger600" />}
                <Typography fontWeight="semiBold">{check.name}</Typography>
                {check.detail ? (
                  <Typography variant="pi" textColor={check.ok ? 'neutral600' : 'danger600'}>{check.detail}</Typography>
                ) : null}
              </Flex>
            ))}
          </Flex>
        </Box>
      ) : null}

      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
        <Flex gap={3} alignItems="center">
          <Typography variant="beta">Backup runner</Typography>
          <Badge variant={runner.healthy ? 'success' : 'warning'}>
            {runner.healthy ? 'Online' : runner.state === 'misconfigured' ? 'Misconfigured' : 'Offline'}
          </Badge>
        </Flex>
        <Box paddingTop={5}>
          <Grid.Root gap={5}>
            <Row label="Last heartbeat" value={formatDateTime(runner.heartbeatAt)} />
            <Row label="Worker" value={runner.workerId} />
            <Row label="pg_dump" value={runner.pgDumpVersion ? `PostgreSQL ${runner.pgDumpVersion}` : null} />
            <Row label="Database server" value={runner.serverVersion ? `PostgreSQL ${runner.serverVersion}` : null} />
          </Grid.Root>
        </Box>
        <Box paddingTop={4}>
          <Typography variant="pi" textColor="neutral600">
            Exactly one container runs backups (BACKUP_RUNNER_ENABLED=true, the maintenance
            service in production). Queued backups wait while it is offline and start within
            about 30 seconds once it is back.
          </Typography>
        </Box>
      </Box>
    </Flex>
  );
}
