import { afterEach, expect, it, vi } from 'vitest';
import { refreshStatus } from './refresh-status';
vi.mock('../../../isr-outbox/config', () => ({ readIsrOutboxConfig: () => ({ gatewayUrl: 'http://gateway.test', adminSecret: 'secret' }) }));
function strapiWith(row: unknown) {
  const query = { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(row) };
  return { db: { connection: vi.fn(() => query) } } as any;
}
const delivered = { id: 1, status: 'delivered', payload: { manualRefresh: true, paths: ['/'] }, delivery_receipt: { paths: [{ path: '/', version: 7 }] } };
afterEach(() => vi.unstubAllGlobals());
it('does not claim global completion or query every website page', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await refreshStatus(strapiWith({ ...delivered, payload: { all: true } }), '1')).toMatchObject({ state: 'accepted' });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['rendered', 'failed', 'accepted'])('checks actual gateway render state %s', async (state) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ state })));
  vi.stubGlobal('fetch', fetch);
  expect(await refreshStatus(strapiWith(delivered), '1')).toMatchObject({ state: state === 'accepted' ? 'rendering' : state });
  expect(fetch).toHaveBeenCalledWith('http://gateway.test/internal/isr/render-status?path=%2F&version=7', expect.anything());
});
it('keeps delivery errors private and never marks a retry as completed', async () => {
  const result = await refreshStatus(strapiWith({ ...delivered, status: 'pending', last_error: 'secret internal url' }), '1');
  expect(result).toMatchObject({ state: 'queued' });
  expect(JSON.stringify(result)).not.toContain('secret internal url');
});
it('reports unavailable paths without claiming regeneration succeeded', async () => {
  expect(await refreshStatus(strapiWith({ ...delivered, delivery_receipt: { paths: [] } }), '1')).toMatchObject({ state: 'unavailable' });
});
it('does not turn a status outage into a false success', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect(await refreshStatus(strapiWith(delivered), '1')).toMatchObject({ state: 'rendering' });
});
it('returns actual generation time and per-page diagnostics from the gateway', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ state: 'rendered', checkedAt: 1700000001000, paths: [{ path: '/', state: 'rendered', renderedAt: 1700000000000, renderedVersion: 7, targetVersion: 7, cachedHttpStatus: 200 }] }))));
  expect(await refreshStatus(strapiWith(delivered), '1')).toMatchObject({ checkedAt: '2023-11-14T22:13:21.000Z', pages: [{ path: '/', generatedAt: '2023-11-14T22:13:20.000Z', cachedHttpStatus: 200 }] });
});
it('reports status-check HTTP errors separately from regeneration failures', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  expect(await refreshStatus(strapiWith(delivered), '1')).toMatchObject({ state: 'rendering', statusError: 'Gateway status check returned HTTP 503' });
});

it.each([['active', 'rendering'], ['completed', 'accepted'], ['failed', 'failed']])('tracks durable scan state %s without claiming all renders complete', async (gatewayState, state) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ state: gatewayState })));
  const row = { ...delivered, payload: { all: true }, delivery_receipt: { jobId: 'manual-123' } };
  expect(await refreshStatus(strapiWith(row), '1')).toMatchObject({ state });
});
it('allows a new request when the retained scan history has expired', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  const row = { ...delivered, payload: { all: true }, delivery_receipt: { jobId: 'manual-123' } };
  expect(await refreshStatus(strapiWith(row), '1')).toMatchObject({ state: 'unavailable' });
});
