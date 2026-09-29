import type { Core } from '@strapi/strapi';
import { ISR_OUTBOX_TABLE } from '../../../isr-outbox/store';
import { readIsrOutboxConfig } from '../../../isr-outbox/config';
import { diagnosticMessage, pageDiagnostics, timestamp } from './refresh-diagnostics';

export async function refreshStatus(strapi: Core.Strapi, id: string) {
  const row = await strapi.db.connection(ISR_OUTBOX_TABLE).where({ id }).where('reason', 'like', 'manual-refresh:%').first();
  if (!row) return null;
  const config = readIsrOutboxConfig();
  const base = {
    id: String(row.id), requestedAt: timestamp(row.created_at), acceptedAt: timestamp(row.delivered_at),
    attempts: Number(row.attempt_count ?? 0), checkedAt: new Date().toISOString(),
    deliveryError: diagnosticMessage(row.last_error, [config.adminSecret]),
    nextRetryAt: row.status === 'pending' ? timestamp(row.next_attempt_at) : null,
    deliveryKey: row.delivery_key ?? null,
  };
  if (row.status === 'invalid' || row.status === 'failed') return { ...base, state: 'failed', message: 'Refresh delivery failed. Review the error, check the website gateway version, then retry.' };
  if (row.status === 'superseded') return { ...base, state: 'superseded', message: 'Combined with a newer refresh request.' };
  if (row.status !== 'delivered') return { ...base, state: 'queued', message: row.last_error ? 'Waiting to retry delivery. Existing cached pages remain available.' : 'Queued for delivery to the website.' };
  const receipt = typeof row.delivery_receipt === 'string' ? JSON.parse(row.delivery_receipt) : row.delivery_receipt;
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  // Global/on-demand warm jobs do not promise that every cold page is rendered.
  if (payload?.all && receipt?.jobId) {
    try {
      const response = await fetch(`${config.gatewayUrl}/internal/isr/manual-refresh/status/${encodeURIComponent(receipt.jobId)}`, {
        headers: { authorization: `Bearer ${config.adminSecret}` }, signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) return { ...base, state: 'unavailable', message: 'Refresh history is no longer available. You can submit a new refresh.' };
      if (!response.ok) throw new Error(`Gateway status check returned HTTP ${response.status}`);
      const job = await response.json() as { state: string; error?: string };
      return { ...base, state: job.state === 'failed' ? 'failed' : job.state === 'completed' ? 'accepted' : 'rendering',
        deliveryError: diagnosticMessage(job.error, [config.adminSecret]),
        message: job.state === 'completed' ? 'Refresh scan completed. Queued pages continue regenerating.' : job.state === 'failed'
          ? 'Website refresh failed. Review the error and retry.' : 'Website refresh is running in the background.' };
    } catch (error) {
      return { ...base, state: 'rendering', statusError: diagnosticMessage(String(error), [config.adminSecret]), message: 'Refresh status is temporarily unavailable.' };
    }
  }
  if (payload?.all) return { ...base, state: 'accepted', message: 'Website accepted the refresh. Pages regenerate in the background; this is not a completion confirmation.' };
  if (!receipt?.paths?.length) return { ...base, state: 'unavailable', message: 'No matching live page was refreshed. Check that it is published and available in this language.' };
  try {
    const query = new URLSearchParams();
    for (const entry of receipt.paths) { query.append('path', entry.path); query.append('version', String(entry.version)); }
    const response = await fetch(`${config.gatewayUrl}/internal/isr/render-status?${query}`, {
      headers: { authorization: `Bearer ${config.adminSecret}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Gateway status check returned HTTP ${response.status}`);
    const result = await response.json() as { state: string; paths?: unknown; checkedAt?: number };
    const details = { ...base, checkedAt: timestamp(result.checkedAt) ?? base.checkedAt, pages: pageDiagnostics(result.paths, config.adminSecret), removedPaths: receipt.removedPaths ?? [] };
    if (result.state === 'rendered') return { ...details, state: 'rendered', message: receipt.removedPaths?.length ? 'Available pages refreshed. Some requested pages are not live in the selected languages.' : 'Page refreshed successfully.' };
    if (result.state === 'failed') return { ...details, state: 'failed', message: 'Page regeneration failed. The previous cached page remains available where present. You can retry.' };
    return { ...details, state: 'rendering', message: 'Regenerating the page. The current cached version remains available.' };
  } catch (error) {
    return { ...base, statusError: diagnosticMessage(error instanceof Error ? error.message : 'Status check failed', [config.adminSecret]), state: 'rendering', message: 'Refresh accepted; completion status is temporarily unavailable.' };
  }
}
