import * as React from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Grid,
  NumberInput,
  SingleSelect,
  SingleSelectOption,
  TextInput,
  Toggle,
  Typography,
} from '@strapi/design-system';

import {
  BACKUP_DELETE_AFTER_DAYS_MAX,
  BACKUP_INTERVAL_HOURS,
  BACKUP_MINIMUM_KEPT,
  isBackupIntervalHours,
  type BackupSettings,
} from '../../../../constants/database-backup';
import { formatScheduledAt } from '../api';
import type { DatabaseBackupsState } from '../use-database-backups';

/**
 * Schedule, retention, verification and alerting. Every field is persisted
 * server-side in the core store and applied by the runner on its next tick,
 * so no restart is needed after Save.
 */
export function BackupSettingsTab({ state }: { state: DatabaseBackupsState }) {
  const overview = state.overview!;
  const [form, setForm] = React.useState<BackupSettings>(overview.settings);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => {
    if (!dirty) setForm(overview.settings);
  }, [overview.settings, dirty]);

  const set = <K extends keyof BackupSettings>(key: K, value: BackupSettings[K]) => {
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const deleteEnabled = form.deleteAfterDays !== null;

  return (
    <Flex direction="column" alignItems="stretch" gap={6}>
      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
        <Flex justifyContent="space-between" alignItems="center" gap={4} wrap="wrap">
          <Typography variant="beta">Backup schedule</Typography>
          <Typography variant="pi" textColor="neutral600">Server timezone: UTC</Typography>
        </Flex>
        <Box paddingTop={5}>
          <Grid.Root gap={5}>
            <Grid.Item col={4} s={12} xs={12}>
              <Field.Root name="scheduleEnabled" hint="Takes a full database backup on the interval below.">
                <Field.Label>Automatic backups</Field.Label>
                <Toggle
                  checked={form.scheduleEnabled}
                  onLabel="On"
                  offLabel="Off"
                  onChange={() => set('scheduleEnabled', !form.scheduleEnabled)}
                />
                <Field.Hint />
              </Field.Root>
            </Grid.Item>
            <Grid.Item col={4} s={12} xs={12}>
              <Field.Root name="intervalHours" hint="Runs at UTC boundaries: every 6 h means 00:00, 06:00, 12:00 and 18:00 UTC.">
                <Field.Label>Interval</Field.Label>
                <SingleSelect
                  value={String(form.intervalHours)}
                  disabled={!form.scheduleEnabled}
                  onChange={(value) => {
                    const hours = Number(value);
                    if (isBackupIntervalHours(hours)) set('intervalHours', hours);
                  }}
                >
                  {BACKUP_INTERVAL_HOURS.map((hours) => (
                    <SingleSelectOption key={hours} value={String(hours)}>
                      {hours === 1 ? 'Every hour' : hours === 24 ? 'Every day' : `Every ${hours} hours`}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
                <Field.Hint />
              </Field.Root>
            </Grid.Item>
            <Grid.Item col={4} s={12} xs={12}>
              <Field.Root name="nextRun">
                <Field.Label>Next scheduled backup</Field.Label>
                <Typography>
                  {overview.settings.scheduleEnabled ? formatScheduledAt(overview.nextScheduledAt) : 'Off'}
                </Typography>
                {dirty ? (
                  <Typography variant="pi" textColor="neutral600">Save to apply the new schedule.</Typography>
                ) : null}
              </Field.Root>
            </Grid.Item>
          </Grid.Root>
        </Box>
      </Box>

      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
        <Typography variant="beta">Retention</Typography>
        <Box paddingTop={5}>
          <Grid.Root gap={5}>
            <Grid.Item col={4} s={12} xs={12}>
              <Field.Root name="deleteEnabled">
                <Field.Label>Delete old backups</Field.Label>
                <Toggle
                  checked={deleteEnabled}
                  onLabel="On"
                  offLabel="Off"
                  onChange={() => set('deleteAfterDays', deleteEnabled ? null : 7)}
                />
              </Field.Root>
            </Grid.Item>
            <Grid.Item col={4} s={12} xs={12}>
              <Field.Root
                name="deleteAfterDays"
                hint={`The newest ${BACKUP_MINIMUM_KEPT} successful backups are always kept, whatever their age.`}
              >
                <Field.Label>Delete after (days)</Field.Label>
                <NumberInput
                  value={form.deleteAfterDays ?? undefined}
                  disabled={!deleteEnabled}
                  min={1}
                  max={BACKUP_DELETE_AFTER_DAYS_MAX}
                  onValueChange={(value) => {
                    if (typeof value === 'number' && Number.isFinite(value)) {
                      set('deleteAfterDays', Math.max(1, Math.min(BACKUP_DELETE_AFTER_DAYS_MAX, Math.round(value))));
                    }
                  }}
                />
                <Field.Hint />
              </Field.Root>
            </Grid.Item>
          </Grid.Root>
        </Box>
      </Box>

      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
        <Typography variant="beta">Verification and alerts</Typography>
        <Box paddingTop={5}>
          <Grid.Root gap={5}>
            <Grid.Item col={4} s={12} xs={12}>
              <Field.Root
                name="autoVerify"
                hint="Streams each new archive back through pg_restore --list right after upload. Downloads the whole file again."
              >
                <Field.Label>Verify every backup automatically</Field.Label>
                <Toggle
                  checked={form.autoVerify}
                  onLabel="On"
                  offLabel="Off"
                  onChange={() => set('autoVerify', !form.autoVerify)}
                />
                <Field.Hint />
              </Field.Root>
            </Grid.Item>
            <Grid.Item col={8} s={12} xs={12}>
              <Field.Root
                name="alertEmail"
                hint="Emailed when a backup fails or none has succeeded for more than twice the interval. Needs the SMTP email settings."
              >
                <Field.Label>Failure alert email</Field.Label>
                <TextInput
                  type="email"
                  value={form.alertEmail ?? ''}
                  placeholder="ops@example.com"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    set('alertEmail', event.target.value.trim() ? event.target.value : null)
                  }
                />
                <Field.Hint />
              </Field.Root>
            </Grid.Item>
          </Grid.Root>
        </Box>
      </Box>

      <Flex justifyContent="flex-end">
        <Button
          disabled={!dirty || state.busy !== null}
          loading={state.busy === 'save-settings'}
          onClick={async () => {
            // Only a confirmed save may clear `dirty`: the sync effect above
            // would otherwise replace the edited form with the last saved
            // settings after a validation or network failure and disable Save.
            if (await state.saveSettings(form)) setDirty(false);
          }}
        >
          Save backup settings
        </Button>
      </Flex>
    </Flex>
  );
}
