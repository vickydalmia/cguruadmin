import type { Core } from '@strapi/strapi';

import type { BackupRunView } from '../constants/database-backup';
import { STALE_ALERT_MIN_GAP_MS } from './constants';
import { logDatabaseBackup } from './log';

/**
 * Failure and staleness emails through the configured Strapi email plugin
 * (nodemailer/SMTP). Every alert is also an `alert: true` JSON log line, so a
 * missing SMTP setup degrades to log-based alerting instead of silence.
 */

export function staleBackupAlertDue(input: {
  now: Date;
  stale: boolean;
  lastAlertAt: Date | null;
}): boolean {
  if (!input.stale) return false;
  if (!input.lastAlertAt) return true;
  return input.now.getTime() - input.lastAlertAt.getTime() >= STALE_ALERT_MIN_GAP_MS;
}

async function sendEmail(
  strapi: Core.Strapi,
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
  try {
    const email = (strapi.plugin('email') as any)?.service('email');
    if (!email || typeof email.send !== 'function') return false;
    await email.send({ to, subject, text });
    return true;
  } catch (error) {
    logDatabaseBackup(strapi, 'warn', 'backup.alert_email_failed', {
      to,
      error: String((error as Error)?.message ?? error),
    });
    return false;
  }
}

function adminUrl(): string | null {
  const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}/admin/settings/database-backups` : null;
}

export async function sendBackupFailureAlert(
  strapi: Core.Strapi,
  alertEmail: string | null,
  run: BackupRunView,
  countryCode: string | null,
): Promise<void> {
  logDatabaseBackup(strapi, 'error', 'backup.failed', {
    alert: true,
    runId: run.id,
    trigger: run.trigger,
    attempt: run.attemptCount,
    error: run.error,
  });
  if (!alertEmail) return;
  const lines = [
    `A database backup failed${countryCode ? ` for ${countryCode}` : ''}.`,
    '',
    `Run: ${run.id}`,
    `Trigger: ${run.trigger}`,
    `Attempt: ${run.attemptCount}`,
    `Started: ${run.startedAt ?? 'n/a'}`,
    `Error: ${run.error ?? 'unknown'}`,
  ];
  const url = adminUrl();
  if (url) lines.push('', `Details: ${url}`);
  await sendEmail(strapi, alertEmail, `[CMS${countryCode ? ` ${countryCode}` : ''}] Database backup failed`, lines.join('\n'));
}

export async function sendBackupStaleAlert(
  strapi: Core.Strapi,
  alertEmail: string | null,
  lastSuccessAt: string | null,
  countryCode: string | null,
): Promise<void> {
  logDatabaseBackup(strapi, 'error', 'backup.stale', { alert: true, lastSuccessAt });
  if (!alertEmail) return;
  const lines = [
    `No successful database backup has completed recently${countryCode ? ` for ${countryCode}` : ''}.`,
    '',
    `Last success: ${lastSuccessAt ?? 'never'}`,
  ];
  const url = adminUrl();
  if (url) lines.push('', `Details: ${url}`);
  await sendEmail(strapi, alertEmail, `[CMS${countryCode ? ` ${countryCode}` : ''}] Database backups are stale`, lines.join('\n'));
}
