/** Small database capability helpers shared by queue code and local-dev fallbacks. */

const POSTGRES_CLIENTS = new Set(['pg', 'postgres', 'postgresql']);
const SQLITE_CLIENTS = new Set(['sqlite', 'sqlite3', 'better-sqlite3']);

export function databaseClient(value: any): string | null {
  const client =
    value?.client?.config?.client ??
    value?.client?.dialect ??
    value?.config?.client ??
    value?.dialect;
  return typeof client === 'string' ? client.toLowerCase() : null;
}

export function isPostgresConnection(value: any): boolean {
  const client = databaseClient(value);
  // Existing unit-test transaction doubles do not expose a client. Preserve
  // the production/Postgres path for those doubles; real SQLite connections
  // always identify themselves.
  return client === null || POSTGRES_CLIENTS.has(client);
}

export function isSqliteConnection(value: any): boolean {
  const client = databaseClient(value);
  return client !== null && SQLITE_CLIENTS.has(client);
}

export async function advisoryTransactionLock(
  transaction: any,
  key: string,
): Promise<void> {
  if (!isPostgresConnection(transaction)) return;
  await transaction.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [key]);
}
