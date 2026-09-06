/**
 * Pure builder for the `pg_dump` / `pg_restore` child process: which
 * arguments to pass and which environment to give libpq. No I/O — the CA
 * file is materialised by `pg-dump.ts`.
 *
 * Everything reaches libpq through `PG*` environment variables and never
 * through argv or a URI, so the password is not visible in `ps` and no URI
 * parameter can downgrade `PGSSLMODE`.
 */

export type ConnectionEnvInput = {
  DATABASE_URL?: string;
  DATABASE_HOST?: string;
  DATABASE_PORT?: string;
  DATABASE_NAME?: string;
  DATABASE_USERNAME?: string;
  DATABASE_PASSWORD?: string;
  DATABASE_SCHEMA?: string;
  DATABASE_SSL?: string;
  DATABASE_SSL_REJECT_UNAUTHORIZED?: string;
  DATABASE_SSL_CA_PATH?: string;
  DATABASE_SSL_CA?: string;
  PATH?: string;
  HOME?: string;
  LANG?: string;
};

export type PgConnection = {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  schema: string;
};

export type SslPlan =
  | { mode: 'prefer' | 'require' }
  | { mode: 'verify-full'; rootCert: 'system' | 'file' };

export type PgInvocation = {
  /** Allow-listed environment for the child (PATH/HOME/LANG + PG*). */
  childEnv: Record<string, string>;
  /** `pg_dump` arguments; stdout carries the archive. */
  dumpArgs: string[];
  ssl: SslPlan;
  /** PEM to write to disk when `ssl.rootCert === 'file'` and no path exists. */
  caPem: string | null;
  /** Existing CA path to reference verbatim. */
  caPath: string | null;
  /** Values that must never appear in logs or persisted errors. */
  secrets: string[];
};

function flag(value: string | undefined, fallback: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Same rule as `readCA` in config/database.ts: raw PEM or base64 PEM. */
export function decodeCaPem(raw: string | undefined): string | null {
  const compact = (raw ?? '').trim();
  if (!compact) return null;
  if (compact.startsWith('-----BEGIN')) return compact;
  const decoded = Buffer.from(compact.replace(/\s/g, ''), 'base64').toString('utf8');
  return decoded.includes('-----BEGIN') ? decoded : null;
}

export function parseConnection(env: ConnectionEnvInput): PgConnection {
  const schema = env.DATABASE_SCHEMA?.trim() || 'public';
  const url = env.DATABASE_URL?.trim();
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('DATABASE_URL is not a valid URL');
    }
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
      throw new Error('DATABASE_URL must use the postgres:// scheme');
    }
    return {
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: decode(parsed.pathname.replace(/^\//, '')),
      user: decode(parsed.username),
      password: decode(parsed.password),
      schema,
    };
  }
  return {
    host: env.DATABASE_HOST?.trim() || 'localhost',
    port: env.DATABASE_PORT?.trim() || '5432',
    database: env.DATABASE_NAME?.trim() || 'strapi',
    user: env.DATABASE_USERNAME?.trim() || 'strapi',
    password: env.DATABASE_PASSWORD ?? 'strapi',
    schema,
  };
}

export function planSsl(env: ConnectionEnvInput): SslPlan {
  if (!flag(env.DATABASE_SSL, false)) return { mode: 'prefer' };
  const hasCa = Boolean(env.DATABASE_SSL_CA_PATH?.trim()) || decodeCaPem(env.DATABASE_SSL_CA) !== null;
  if (hasCa) return { mode: 'verify-full', rootCert: 'file' };
  if (!flag(env.DATABASE_SSL_REJECT_UNAUTHORIZED, true)) return { mode: 'require' };
  return { mode: 'verify-full', rootCert: 'system' };
}

export type InvocationOptions = {
  compression: string;
  /** Absolute path the CA PEM will be written to when it has to be materialised. */
  caFilePath: string;
};

export function buildPgInvocation(env: ConnectionEnvInput, options: InvocationOptions): PgInvocation {
  const connection = parseConnection(env);
  const ssl = planSsl(env);
  const caPath = env.DATABASE_SSL_CA_PATH?.trim() || null;
  const caPem = caPath ? null : decodeCaPem(env.DATABASE_SSL_CA);

  const childEnv: Record<string, string> = {
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: env.HOME ?? '/tmp',
    LANG: env.LANG ?? 'C.UTF-8',
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGDATABASE: connection.database,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'cguru-db-backup',
    PGSSLMODE: ssl.mode,
  };
  if (ssl.mode === 'verify-full') {
    childEnv.PGSSLROOTCERT = ssl.rootCert === 'system' ? 'system' : (caPath ?? options.caFilePath);
  }

  const dumpArgs = [
    '--format=custom',
    `--compress=${options.compression}`,
    `--schema=${connection.schema}`,
    '--no-owner',
    '--no-acl',
    '--no-password',
    '--lock-wait-timeout=60000',
  ];

  const secrets = [connection.password].filter((value) => value.length > 0);
  return { childEnv, dumpArgs, ssl, caPem, caPath, secrets };
}

/** Mask credentials in stderr / error text before it is stored or logged. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    output = output.split(secret).join('***');
  }
  output = output.replace(/(PGPASSWORD|password)=\S+/gi, '$1=***');
  output = output.replace(/(:\/\/[^/\s:@]+):[^@\s/]+@/g, '$1:***@');
  return output;
}
