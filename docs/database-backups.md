# Database backups

Settings → **Database Backups** (Super Admin only) takes a full PostgreSQL
dump every 6 hours (interval configurable) and on demand, stores it in a
dedicated Amazon S3 bucket, and keeps a history with download, verify, cancel
and delete. Restore is an operator runbook
(`deployment/docs/16-database-backups.md`), never a button.

The page has three tabs, modelled on the SpinupWP backup screens:

| Tab | What it shows |
|---|---|
| Backups | status badges (schedule, runner, last success, next run), **Back up now** (with an optional note), the active run with Cancel, and the history table: date · type (Scheduled / On-demand + who) · note · size · duration · status · verified · actions |
| Backup Settings | automatic on/off, interval (1–24 h, UTC-aligned), delete after N days (newest 3 always kept), auto-verify, failure alert email |
| Storage Settings | read-only S3 target from the server environment (bucket, region, prefix, encryption, masked key id), **Test connection**, runner health and tool versions |

Credentials live only in the server environment (`BACKUP_S3_*`), never in the
database that is being backed up. The endpoints are enforced by
`global::super-admin-only`; the page hides itself for other roles.

## How a backup runs

1. A row is inserted in `database_backup_runs` (`pending`) — by the runner
   when a UTC schedule slot is due, or by the admin container on **Back up
   now**. A partial unique index allows one pending/running row at a time, so
   a second request answers 409 with the active run.
2. The **runner** (the one container with `BACKUP_RUNNER_ENABLED=true`, in
   production `strapi-maintenance`) ticks every 30 s, claims the row with a
   lease (`lock_token`, `heartbeat_at`), and records the target key
   `<prefix>/<CC>/<YYYY>/<MM>/<DD>/<CC>-strapi-<timestamp>-<run>.dump`.
3. `pg_dump --format=custom --compress=zstd:3 --schema=public --no-owner
   --no-acl --lock-wait-timeout=60000` is spawned with the connection passed
   only through `PG*` environment variables (`PGSSLMODE=verify-full` when a CA
   is configured; the CA PEM from `DATABASE_SSL_CA` is materialised as a 0600
   file under `.tmp/database-backup/`).
4. Its stdout streams through a hashing transform straight into an S3
   multipart upload (8 MiB parts, two in flight) with server-side encryption.
   The transform refuses to end until `pg_dump` exited 0 — a failed dump can
   never be committed as a "complete" small object — and checks the `PGDMP`
   magic. After the upload, `HeadObject` must report the streamed byte count,
   and a `<key>.sha256` sidecar is written.
5. The row becomes `succeeded` with size, sha256, ETag, duration and tool
   versions; retention then deletes archives older than the configured days
   (never the newest three) and history rows older than 180 days.
6. Heartbeats every 15 s also carry the cancel flag: **Cancel** kills
   `pg_dump`, aborts the multipart, and marks the row `cancelled`. A timeout
   (`BACKUP_TIMEOUT_MINUTES`) does the same with `failed`. A container stop
   mid-run hands the row back (`pending`, one retry); a worker that stops
   heartbeating for 3 minutes is handled by the next tick, which inspects the
   bucket recorded on the row BEFORE touching the row: a committed object
   (the worker died between the S3 commit and the database write, or the
   database was restored FROM this archive, whose dump carries its own row as
   `running`) turns the row straight into a normal `succeeded` entry with the
   size, ETag and sidecar checksum, so retention and the admin own it; an
   absent object means the open multipart is aborted and the row is handed
   back for its retry; and a bucket that cannot be inspected leaves the row
   `running` under its dead lease, unclaimable, until a later tick can look —
   handing it back first would let the retry stamp a new key over the only
   reference to a possibly committed archive. The reclaim path never deletes
   an object. Cancel locks the row for its decision, so a run claimed in the
   same instant is flagged rather than reported cancelled while it continues.

Schedule slots are UTC multiples of the interval (every 6 h = 00/06/12/18
UTC). Only the *current* slot is ever considered, so a restart after a long
outage produces exactly one catch-up run, and a manual backup taken inside a
slot satisfies it (no redundant scheduled run right after it). Settings are
re-read every tick, so a change applies without a restart.

**Verify** streams the archive back from S3 into `pg_restore --list` and
stores the table-of-contents entry count. This proves the archive header and
TOC are readable, not the table data behind them: `pg_restore` exits as soon
as the listing is complete, the download stops there, and the resulting
broken pipe is the normal end of a verification. A verification holds a lease
(`verify_heartbeat_at`, refreshed every 15 s); one whose worker vanished
(SIGKILL, OOM) is marked `failed` with "verifier lost its lease" by the next
tick after 3 minutes, and one still running after 10 minutes is failed with
"verification exceeded 10 minutes"; both can be requested again. **Download**
issues a 15-minute presigned URL and navigates the current tab to it (the
URL carries `Content-Disposition: attachment`, so the admin page stays put
and no popup is involved); **Delete** removes the object and its sidecar and
keeps the row as `deleted` (bucket versioning makes it recoverable by an
operator). Verify, download, delete and retention all address the bucket
recorded on the run, so changing `BACKUP_S3_BUCKET` never strands or
misreports older archives.

Every call to the bucket is bounded (10 s to connect, 60 s per request to
its response headers, three attempts), so a silent endpoint fails a backup
instead of hanging it, and the preflight runs from the runner's first tick
rather than inside Strapi bootstrap: a bucket outage can never keep the admin
container from starting. A run that fails after its multipart upload was
already committed (size check, sidecar, database write) deletes the object
and its sidecar again; if that delete fails too, `backup.cleanup_failed` names
the key for an operator.

Alerts: every failure is a JSON log line `{"event":"backup.failed",
"component":"database-backup","alert":true,…}`; with an alert email set, the
same is emailed through the CMS email plugin, plus one "stale" email per day
while no backup has succeeded for more than 2× the interval + 30 min.

## Preflight and health

At start (and every 5 minutes until it passes) the runner checks: Postgres
client, `pg_dump`/`pg_restore` present, client major ≥ server major
(`SHOW server_version_num`), `BACKUP_*` complete, bucket reachable. Problems
are written to the core store and shown verbatim on the page. The runner
heartbeat (core store key `runner`) is what the Storage tab reads; a heartbeat
older than 90 s shows as **Offline**.

Two of those checks behave differently:

- **Incomplete environment** (`BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, the
  access key pair or `DEPLOYMENT_COUNTRY_CODE` missing on the runner
  container): static configuration that only a restart can fix. The runner
  logs ONE `backup.misconfigured` alert at boot (`unconfigured: true`, with a
  message saying no backups will run), repeats it once a day, and does not
  re-run the preflight every 5 minutes. The heartbeat keeps reporting
  **misconfigured** so the Storage tab stays truthful. `deploy.sh` refuses to
  deploy a host in this state (see below), so it is only reachable by editing
  the environment after a deploy or by starting Compose by hand.
- **Configured but failing** (bucket unreachable, wrong credentials, missing
  `pg_dump`): re-checked every 5 minutes with an alert each time, because these
  can be fixed without a restart.

## Backups are mandatory on every host

Every country host (India, USA, UAE and any later one) takes backups; there is
no opt-out. `deploy/scripts/deploy.sh` refuses to deploy when `BACKUP_S3_BUCKET`,
`BACKUP_S3_ACCESS_KEY_ID` or `BACKUP_S3_ACCESS_SECRET` is empty or still a
`change-me` placeholder, or when neither `BACKUP_S3_REGION` nor
`BACKUP_S3_ENDPOINT` is set. It exits before pulling images or stopping
containers, so a misconfigured host keeps its current release running. Use one
dedicated bucket and IAM user per country; the country code is part of every
object key, and buckets are never shared between countries.

Exactly one process takes backups. With the default
`MAINTENANCE_SERVICE_ENABLED=true` that is `strapi-maintenance`. With
`MAINTENANCE_SERVICE_ENABLED=false` (English-only host without the translation
container) `deploy.sh` exports `ADMIN_BACKUP_RUNNER_ENABLED=true` and the admin
container `strapi` runs the backup runner instead: it costs the admin pool one
extra Postgres connection while a dump runs (admin 5 + 1, still inside the
budget the maintenance service would have used) and the pre-migration stop of
the admin container already guarantees no dump overlaps a migration. If you run
Compose by hand on such a host, put `ADMIN_BACKUP_RUNNER_ENABLED=true` in
`.env.production` so the interpolation sees it.

## Local development

Backups need a PostgreSQL `DATABASE_CLIENT` and `pg_dump`/`pg_restore` ≥ the
local server on `PATH` (`brew install libpq`, or `BACKUP_PG_DUMP_PATH`). With
SQLite the page shows "the database client is sqlite" and the runner stays
off. For the bucket use a real dev bucket or MinIO
(`BACKUP_S3_ENDPOINT=http://127.0.0.1:9000`, `BACKUP_S3_FORCE_PATH_STYLE=true`,
`BACKUP_S3_SSE=none`). Set `BACKUP_RUNNER_ENABLED=true` and
`DEPLOYMENT_COUNTRY_CODE=IN` in `.env`.

## Code map

| Path | Owns |
|---|---|
| `src/constants/database-backup.ts` | route prefix, settings shape/defaults, run/overview view types shared by admin and server |
| `src/database-backup/config.ts` | `BACKUP_*` env → config, problem list, key masking |
| `src/database-backup/settings.ts` | core-store settings (zod-validated) and the runner heartbeat record |
| `src/database-backup/schedule.ts` | pure slot arithmetic, next-run, staleness |
| `src/database-backup/pg-connection.ts` | pure `pg_dump` argument/env builder, SSL matrix, CA decode, secret redaction |
| `src/database-backup/pg-dump.ts` | spawn with stderr tail, `ArchiveStream` (bytes/sha256/magic/waits-for-exit), tool version, CA file |
| `src/database-backup/s3-client.ts` / `s3-upload.ts` / `s3-objects.ts` | client, key naming, SSE params; streaming multipart upload + sidecar; head/delete/abort/presign/verify stream/test connection |
| `src/database-backup/verify.ts` | S3 → `pg_restore --list` |
| `src/database-backup/retention.ts` | pure selection (days + newest-3 floor) and the delete sweep |
| `src/database-backup/store.ts` / `store-rows.ts` | lease-guarded lifecycle writes; row mapping and reads |
| `src/database-backup/execute-run.ts` | one backup / one verification from claim to terminal row |
| `src/database-backup/runner.ts` | start/stop/wake, preflight, the 30 s tick |
| `src/database-backup/reclaim.ts` | a stale run's fate, bucket first: reconcile a committed archive, else abort the multipart and hand back, else (uninspectable) leave it running; never delete |
| `src/database-backup/alerts.ts` / `status.ts` / `log.ts` | emails + staleness gate; overview for the page; JSON log lines |
| `src/api/database-backup/controllers/database-backup.ts` | admin endpoints (overview, settings, runs, cancel/verify/delete/download, test connection) |
| `src/register/admin-routes.ts` → `registerDatabaseBackupRoutes` | `/database-backups/*` on the admin router, Super Admin policy |
| `database/migrations/2026.09.10T00.00.00.create-database-backup-runs.js` | the `database_backup_runs` table and partial unique indexes |
| `database/migrations/2026.09.11T00.00.00.database-backup-verify-lease.js` | `verify_heartbeat_at`, the verification lease column |
| `src/admin/features/database-backups/` | `api.ts` (paths, unwrap, formatters), `use-database-backups.ts` (poll + actions), `components/*` (page, three tabs, history table, dialog) |
| `src/admin/utils/super-admin.ts` | `isSuperAdminUser` shared with CSV export |
| `Dockerfile` / `deploy/docker.compose.yml` | `postgresql18-client` + version assertion; `BACKUP_RUNNER_ENABLED` per service |
