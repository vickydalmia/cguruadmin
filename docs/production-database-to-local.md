# Clone the Production Strapi Database to Local PostgreSQL

This runbook copies the production Strapi PostgreSQL database into the local
PostgreSQL database used by `cguruadmin`.

It uses the existing credentials in:

- `migration/.env.migration` for the production database.
- `.env` for the local database.

No password or connection string is printed or pasted into the terminal.

## Important warning

The restore commands below delete everything in the local database's `public`
schema. They do not modify production. Production is accessed only by
`pg_dump`, which performs a read-only export.

Run all commands from:

```bash
cd /Users/vickykumar/Desktop/cguruapp/cguruadmin
```

## 1. Confirm the local database target

Print only the non-secret local database settings:

```bash
awk -F= '/^(DATABASE_CLIENT|DATABASE_HOST|DATABASE_PORT|DATABASE_NAME|DATABASE_USERNAME)=/{print}' .env
```

Expected settings for this project:

```text
DATABASE_CLIENT=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=postgres
DATABASE_USERNAME=postgres
```

Confirm PostgreSQL is listening locally:

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN
```

The host must be `127.0.0.1` or `localhost` before running the destructive
restore steps.

## 2. Locate the PostgreSQL 18 tools

The local PostgreSQL server is supplied by DBngin. Its matching tools are:

```bash
ls -l /Users/Shared/DBngin/postgresql/18.1/bin/{pg_dump,pg_restore,psql}
```

Confirm the version:

```bash
/Users/Shared/DBngin/postgresql/18.1/bin/pg_dump --version
```

Use PostgreSQL 18 tools because production is PostgreSQL 18. An older
`pg_dump`, such as PostgreSQL 17, may refuse to dump a newer server.

## 3. Confirm the production connection without showing its password

```bash
cd migration
node --input-type=module <<'NODE'
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: '.env.migration' });

const url = new URL(process.env.PG_CONNECTION_STRING);
const caPath = path.resolve(process.env.PG_CA_CERT_PATH || '');

console.log({
  host: url.hostname,
  port: url.port || '5432',
  database: url.pathname.slice(1),
  user: url.username,
  caExists: fs.existsSync(caPath),
});
NODE
cd ..
```

For this project, the production host should be the configured DigitalOcean
database, not `127.0.0.1`.

## 4. Export production

This command reads `migration/.env.migration`, connects with TLS using the
configured CA certificate, and creates a custom-format dump in `/private/tmp`.

```bash
cd migration
node --input-type=module <<'NODE'
import dotenv from 'dotenv';
import { spawn } from 'child_process';

dotenv.config({ path: '.env.migration' });

const pgDump = '/Users/Shared/DBngin/postgresql/18.1/bin/pg_dump';
const output = '/private/tmp/cguru-prod-latest.dump';

const child = spawn(
  pgDump,
  [
    '--format=custom',
    '--schema=public',
    '--no-owner',
    '--no-acl',
    '--verbose',
    '--file=' + output,
    process.env.PG_CONNECTION_STRING,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PGSSLROOTCERT: process.env.PG_CA_CERT_PATH,
      PGSSLMODE: 'verify-full',
    },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
NODE
cd ..
```

What the flags mean:

- `--format=custom` creates an archive for `pg_restore`.
- `--schema=public` exports only the Strapi application schema.
- `--no-owner` avoids trying to assign local objects to DigitalOcean's
  `doadmin` role.
- `--no-acl` excludes production grants that may reference unavailable local
  roles.
- `PGSSLMODE=verify-full` encrypts the production connection and verifies its
  hostname and CA.

## 5. Validate the dump before deleting local data

Check that the archive exists:

```bash
ls -lh /private/tmp/cguru-prod-latest.dump
```

Read its archive header and first objects:

```bash
/Users/Shared/DBngin/postgresql/18.1/bin/pg_restore \
  --list /private/tmp/cguru-prod-latest.dump | sed -n '1,45p'
```

Count table-data entries:

```bash
/Users/Shared/DBngin/postgresql/18.1/bin/pg_restore \
  --list /private/tmp/cguru-prod-latest.dump | rg -c ' TABLE DATA public '
```

At the time this process was documented, the dump contained 310 table-data
entries.

## 6. Optional local backup

Skip this section only if the local data is disposable.

```bash
node --input-type=module <<'NODE'
import dotenv from 'dotenv';
import { spawn } from 'child_process';

dotenv.config({ path: '.env' });

const child = spawn(
  '/Users/Shared/DBngin/postgresql/18.1/bin/pg_dump',
  [
    '--host', process.env.DATABASE_HOST,
    '--port', process.env.DATABASE_PORT,
    '--username', process.env.DATABASE_USERNAME,
    '--dbname', process.env.DATABASE_NAME,
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--file=/private/tmp/cguru-local-before-prod-restore.dump',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PGPASSWORD: process.env.DATABASE_PASSWORD,
      PGSSLMODE: 'disable',
    },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
NODE
```

## 7. Restore production into local

Do not run Strapi while restoring. Check port 1337 first:

```bash
lsof -nP -iTCP:1337 -sTCP:LISTEN
```

If the command prints a Strapi process, stop that development server before
continuing.

Run the restore:

```bash
node --input-type=module <<'NODE'
import dotenv from 'dotenv';
import { spawn } from 'child_process';

dotenv.config({ path: '.env' });

const bin = '/Users/Shared/DBngin/postgresql/18.1/bin/';
const dump = '/private/tmp/cguru-prod-latest.dump';
const databaseArgs = [
  '--host', process.env.DATABASE_HOST,
  '--port', process.env.DATABASE_PORT,
  '--username', process.env.DATABASE_USERNAME,
  '--dbname', process.env.DATABASE_NAME,
];
const childEnv = {
  ...process.env,
  PGPASSWORD: process.env.DATABASE_PASSWORD,
  PGSSLMODE: 'disable',
};

function run(label, command, args) {
  return new Promise((resolve, reject) => {
    console.log(label);
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: childEnv,
    });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(label + ' failed with exit code ' + code));
    });
  });
}

await run(
  'Resetting local public schema',
  bin + 'psql',
  [
    ...databaseArgs,
    '--set', 'ON_ERROR_STOP=1',
    '--quiet',
    '--command',
    'SET client_min_messages=warning; DROP SCHEMA public CASCADE;',
  ],
);

await run(
  'Restoring schema',
  bin + 'pg_restore',
  [
    ...databaseArgs,
    '--section=pre-data',
    '--exit-on-error',
    '--no-owner',
    '--no-acl',
    dump,
  ],
);

await run(
  'Installing pg_trgm',
  bin + 'psql',
  [
    ...databaseArgs,
    '--set', 'ON_ERROR_STOP=1',
    '--quiet',
    '--command',
    'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;',
  ],
);

await run(
  'Restoring data',
  bin + 'pg_restore',
  [
    ...databaseArgs,
    '--section=data',
    '--exit-on-error',
    '--no-owner',
    '--no-acl',
    dump,
  ],
);

await run(
  'Restoring indexes, constraints, and triggers',
  bin + 'pg_restore',
  [
    ...databaseArgs,
    '--section=post-data',
    '--exit-on-error',
    '--no-owner',
    '--no-acl',
    dump,
  ],
);

console.log('RESTORE_COMPLETE');
NODE
```

### Why the restore is split into three sections

Production uses the `pg_trgm` extension for GIN trigram search indexes. A dump
restricted to `--schema=public` contains indexes that use
`public.gin_trgm_ops`, but PostgreSQL does not include the extension itself as
a normal schema object.

The required order is therefore:

1. Restore `pre-data` to create the `public` schema, tables, sequences, and
   functions.
2. Install `pg_trgm` into `public`.
3. Restore the table data.
4. Restore `post-data`, which creates indexes, constraints, and triggers.

Trying to restore everything in one command without installing `pg_trgm`
causes this error:

```text
ERROR: operator class "public.gin_trgm_ops" does not exist for access method "gin"
```

## 8. Verify the local database

This check reports table counts, index health, and important Strapi entity
counts without printing any content or credentials:

```bash
node --input-type=module <<'NODE'
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env' });

const client = new pg.Client({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  ssl: false,
});

await client.connect();

const result = await client.query(`
  SELECT
    (SELECT count(*)::int FROM pg_tables
      WHERE schemaname = 'public') AS tables,
    (SELECT count(*)::int FROM pg_indexes
      WHERE schemaname = 'public') AS indexes,
    (SELECT count(*)::int
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT i.indisvalid) AS invalid_indexes,
    (SELECT count(*)::int FROM stores) AS stores,
    (SELECT count(*)::int FROM brands) AS brands,
    (SELECT count(*)::int FROM categories) AS categories,
    (SELECT count(*)::int FROM banks) AS banks,
    (SELECT count(*)::int FROM coupons) AS coupons,
    (SELECT count(*)::int FROM deals) AS deals,
    (SELECT count(*)::int FROM files) AS files,
    (SELECT count(*)::int FROM unique_coupon_pools) AS pools,
    (SELECT count(*)::int FROM unique_codes) AS unique_codes,
    (SELECT count(*)::int FROM admin_users) AS admin_users
`);

console.log(result.rows[0]);
await client.end();
NODE
```

For the copy made on August 6, 2026, verification returned:

```text
tables: 310
indexes: 1023
invalid_indexes: 0
stores: 3045
brands: 994
categories: 123
banks: 21
coupons: 25342
deals: 555
files: 4997
pools: 9
unique_codes: 570966
admin_users: 12
```

The exact content counts will change as production changes. The important
index result is always:

```text
invalid_indexes: 0
```

## 9. Start local Strapi safely

The production database includes cron-managed content and ISR outbox state.
Disable background coordination when starting the local development copy:

```bash
CRON_ENABLED=false ISR_OUTBOX_DISPATCHER_ENABLED=false yarn develop
```

Then open:

```text
http://localhost:1337/admin
```

Production admin users and password hashes are part of the database copy.
Existing production browser sessions may not work locally because the local
Strapi secrets are different; log in again through the local admin page.

## 10. Remove the temporary dump when finished

The dump contains production data and must be treated as sensitive.

After confirming local Strapi works, remove it:

```bash
rm /private/tmp/cguru-prod-latest.dump
```

If an optional local backup was created and is no longer needed, remove it
separately:

```bash
rm /private/tmp/cguru-local-before-prod-restore.dump
```

## Common errors

### `relation already exists`

The dump was imported on top of an existing Strapi schema. Drop the local
`public` schema and follow the sectioned restore in step 7.

### `duplicate key value violates unique constraint`

Existing local rows were not removed before importing production rows. Use the
clean-schema restore in step 7.

### `gin_trgm_ops does not exist`

The `pg_trgm` extension was not installed before restoring post-data. Follow
the exact pre-data → extension → data → post-data order in step 7.

### `server version mismatch`

An older `pg_dump` is being used against PostgreSQL 18. Use the DBngin 18.1
binary shown in step 2.

### TLS or certificate error

Confirm `PG_CA_CERT_PATH` in `migration/.env.migration` points to an existing
DigitalOcean CA certificate. Do not solve this by disabling certificate
verification for production.

### Strapi starts changing content or sending revalidation requests

Stop Strapi and restart it with both background systems disabled:

```bash
CRON_ENABLED=false ISR_OUTBOX_DISPATCHER_ENABLED=false yarn develop
```
