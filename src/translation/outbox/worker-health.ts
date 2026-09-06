import type { Core } from '@strapi/strapi';

const TABLE = 'translation_worker_heartbeats';

export async function writeWorkerHeartbeat(strapi: Core.Strapi, workerId: string, state: string) {
  const row = { worker_id: workerId, heartbeat_at: new Date(), state };
  await strapi.db.connection(TABLE).insert(row).onConflict('worker_id').merge(row);
  await strapi.db.connection(TABLE)
    .where('heartbeat_at', '<', new Date(Date.now() - 86_400_000)).delete();
}

export async function readWorkerHeartbeat(strapi: Core.Strapi) {
  const row = await strapi.db.connection(TABLE).orderBy('heartbeat_at', 'desc').first();
  if (!row) return { state: 'unavailable', healthy: false, heartbeatAt: null };
  return {
    state: row.state,
    healthy: row.state === 'running' && Date.now() - new Date(row.heartbeat_at).getTime() < 60_000,
    heartbeatAt: new Date(row.heartbeat_at).toISOString(),
  };
}
