import * as React from 'react';
import { Box, Tabs } from '@strapi/design-system';
import { Layouts, Page, useAuth } from '@strapi/strapi/admin';

import { isSuperAdminUser } from '../../../utils/super-admin';
import { useDatabaseBackups } from '../use-database-backups';
import { BackupSettingsTab } from './backup-settings-tab';
import { BackupsTab } from './backups-tab';
import { StorageTab } from './storage-tab';

/**
 * Settings → Database Backups. Super Admin only: the role check here only
 * decides what to render; every endpoint behind the page is enforced by
 * `global::super-admin-only`, and a 403 renders the same NoPermissions view.
 */
export default function DatabaseBackupsPage() {
  const user = useAuth('DatabaseBackupsPage', (auth) => auth.user);
  const state = useDatabaseBackups();

  if (!isSuperAdminUser(user) || state.forbidden) return <Page.NoPermissions />;
  if (state.loading) return <Page.Loading />;
  if (state.error || !state.overview) {
    return (
      <Page.Main>
        <Page.Title>Database Backups</Page.Title>
        <Page.Error content={state.error ?? 'Database backups are unavailable.'} />
      </Page.Main>
    );
  }

  return (
    <Page.Main>
      <Page.Title>Database Backups</Page.Title>
      <Layouts.Root>
        <Layouts.Header
          title="Database Backups"
          subtitle="Automatic PostgreSQL dumps to Amazon S3, on-demand backups, and history"
        />
        <Layouts.Content>
          <Tabs.Root defaultValue="backups" variant="simple">
            <Tabs.List aria-label="Database backup sections">
              <Tabs.Trigger value="backups">Backups</Tabs.Trigger>
              <Tabs.Trigger value="settings">Backup Settings</Tabs.Trigger>
              <Tabs.Trigger value="storage">Storage Settings</Tabs.Trigger>
            </Tabs.List>
            <Box paddingTop={6}>
              <Tabs.Content value="backups">
                <BackupsTab state={state} />
              </Tabs.Content>
              <Tabs.Content value="settings">
                <BackupSettingsTab state={state} />
              </Tabs.Content>
              <Tabs.Content value="storage">
                <StorageTab state={state} />
              </Tabs.Content>
            </Box>
          </Tabs.Root>
        </Layouts.Content>
      </Layouts.Root>
    </Page.Main>
  );
}
